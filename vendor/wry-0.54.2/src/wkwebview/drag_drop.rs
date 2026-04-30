#![allow(deprecated)]

// Copyright 2020-2023 Tauri Programme within The Commons Conservancy
// SPDX-License-Identifier: Apache-2.0
// SPDX-License-Identifier: MIT

use std::{
  ffi::CStr,
  fs,
  ptr::NonNull,
  path::PathBuf,
  process,
  sync::{Arc, Mutex},
  thread,
  time::{SystemTime, UNIX_EPOCH},
};

use objc2::{
  runtime::{AnyObject, Bool, ProtocolObject},
  AnyThread, ClassType, DeclaredClass,
};
use objc2_app_kit::{
  NSDragOperation, NSDraggingInfo, NSFilePromiseReceiver, NSFilesPromisePboardType, NSImage,
  NSPasteboard, NSPasteboardTypeFileURL, NSPasteboardTypePNG, NSPasteboardTypeTIFF,
  NSURLPboardType, NSFilenamesPboardType,
};
use objc2_foundation::{NSArray, NSDictionary, NSError, NSOperationQueue, NSPoint, NSRect, NSString, NSURL};

use crate::DragDropEvent;

use super::WryWebView;

fn temp_drag_image_path(ext: &str) -> PathBuf {
  let ts = SystemTime::now()
    .duration_since(UNIX_EPOCH)
    .map(|duration| duration.as_nanos())
    .unwrap_or(0);
  std::env::temp_dir().join(format!(
    "codex-monitor-drag-image-{}-{ts}.{ext}",
    process::id()
  ))
}

fn temp_drag_file_dir() -> PathBuf {
  let ts = SystemTime::now()
    .duration_since(UNIX_EPOCH)
    .map(|duration| duration.as_nanos())
    .unwrap_or(0);
  std::env::temp_dir().join(format!(
    "codex-monitor-drag-files-{}-{ts}",
    process::id()
  ))
}

fn write_temp_drag_image(bytes: &[u8], ext: &str) -> Option<PathBuf> {
  if bytes.is_empty() {
    return None;
  }
  let path = temp_drag_image_path(ext);
  fs::write(&path, bytes).ok()?;
  Some(path)
}

fn nsstring_to_path(string: &NSString) -> PathBuf {
  let value = unsafe { CStr::from_ptr(string.UTF8String()) }.to_string_lossy();
  PathBuf::from(value.into_owned())
}

unsafe fn nsstring_to_owned(string: &NSString) -> String {
  CStr::from_ptr(string.UTF8String()).to_string_lossy().into_owned()
}

fn wait_for_paths(paths: &[PathBuf]) {
  for _ in 0..50 {
    if paths.iter().all(|path| path.exists()) {
      break;
    }
    thread::sleep(std::time::Duration::from_millis(20));
  }
}

unsafe fn collect_temp_image_path(pb: &NSPasteboard) -> Option<PathBuf> {
  if let Some(data) = pb.dataForType(NSPasteboardTypePNG) {
    if let Some(path) = write_temp_drag_image(&data.to_vec(), "png") {
      return Some(path);
    }
  }
  if let Some(data) = pb.dataForType(NSPasteboardTypeTIFF) {
    if let Some(path) = write_temp_drag_image(&data.to_vec(), "tiff") {
      return Some(path);
    }
  }
  if NSImage::canInitWithPasteboard(pb) {
    let image = NSImage::initWithPasteboard(NSImage::alloc(), pb)?;
    if let Some(data) = image.TIFFRepresentation() {
      if let Some(path) = write_temp_drag_image(&data.to_vec(), "tiff") {
        return Some(path);
      }
    }
  }
  None
}

unsafe fn collect_file_url_paths(pb: &NSPasteboard) -> Vec<PathBuf> {
  let Some(items) = pb.pasteboardItems() else {
    return Vec::new();
  };
  let mut paths = Vec::new();
  for item in items.iter() {
    let Some(url_string) = item
      .stringForType(NSPasteboardTypeFileURL)
      .or_else(|| item.stringForType(NSURLPboardType))
    else {
      continue;
    };
    if let Some(url) = NSURL::URLWithString(&url_string) {
      if let Some(path) = url.path() {
        paths.push(nsstring_to_path(&path));
        continue;
      }
    }
    let raw = nsstring_to_owned(&url_string);
    if !raw.is_empty() {
      paths.push(PathBuf::from(raw));
    }
  }
  paths
}

unsafe fn collect_file_paths(pb: &NSPasteboard) -> Vec<PathBuf> {
  let mut drag_drop_paths = Vec::new();
  let types = NSArray::arrayWithObject(NSFilenamesPboardType);

  if pb.availableTypeFromArray(&types).is_some() {
    let paths = pb.propertyListForType(NSFilenamesPboardType).unwrap();
    let paths = paths.downcast::<NSArray>().unwrap();
    for path in paths {
      let path = path.downcast::<NSString>().unwrap();
      drag_drop_paths.push(nsstring_to_path(&path));
    }
  }
  if drag_drop_paths.is_empty() {
    drag_drop_paths.extend(collect_file_url_paths(pb));
  }
  drag_drop_paths
}

unsafe fn collect_legacy_promised_file_paths(
  drag_info: &ProtocolObject<dyn NSDraggingInfo>,
) -> Vec<PathBuf> {
  let pb = drag_info.draggingPasteboard();
  let promise_types = NSArray::arrayWithObject(NSFilesPromisePboardType);
  if pb.availableTypeFromArray(&promise_types).is_none() {
    return Vec::new();
  }

  let temp_dir = temp_drag_file_dir();
  if fs::create_dir_all(&temp_dir).is_err() {
    return Vec::new();
  }

  let dir_string = NSString::from_str(&temp_dir.to_string_lossy());
  let destination = NSURL::fileURLWithPath(&dir_string);
  let Some(file_names) = drag_info.namesOfPromisedFilesDroppedAtDestination(&destination) else {
    return Vec::new();
  };

  let promised_paths = file_names
    .iter()
    .map(|file_name| temp_dir.join(nsstring_to_path(&file_name)))
    .collect::<Vec<_>>();

  if !promised_paths.is_empty() {
    wait_for_paths(&promised_paths);
  }

  promised_paths
}

unsafe fn collect_promised_file_receiver_paths(pb: &NSPasteboard) -> Vec<PathBuf> {
  let class_array = NSArray::from_slice(&[NSFilePromiseReceiver::class()]);
  let Some(objects) = pb.readObjectsForClasses_options(&class_array, None) else {
    return Vec::new();
  };

  let temp_dir = temp_drag_file_dir();
  if fs::create_dir_all(&temp_dir).is_err() {
    return Vec::new();
  }
  let dir_string = NSString::from_str(&temp_dir.to_string_lossy());
  let destination = NSURL::fileURLWithPath(&dir_string);
  let queue = NSOperationQueue::new();
  let options = NSDictionary::<AnyObject, AnyObject>::new();
  let collected_paths = Arc::new(Mutex::new(Vec::new()));

  for object in objects.iter() {
    let Ok(receiver) = object.downcast::<NSFilePromiseReceiver>() else {
      continue;
    };
    let collected_paths = Arc::clone(&collected_paths);
    let reader = block2::RcBlock::new(move |file_url: NonNull<NSURL>, error: *mut NSError| {
      if !error.is_null() {
        return;
      }
      let file_url = unsafe { file_url.as_ref() };
      if let Some(path) = file_url.path() {
        collected_paths.lock().unwrap().push(nsstring_to_path(&path));
      }
    });
    receiver.receivePromisedFilesAtDestination_options_operationQueue_reader(
      &destination,
      &options,
      &queue,
      &reader,
    );
  }

  queue.waitUntilAllOperationsAreFinished();
  let promised_paths = collected_paths.lock().unwrap().clone();
  if !promised_paths.is_empty() {
    wait_for_paths(&promised_paths);
  }
  promised_paths
}

unsafe fn collect_promised_file_paths(
  drag_info: &ProtocolObject<dyn NSDraggingInfo>,
) -> Vec<PathBuf> {
  let pb = drag_info.draggingPasteboard();
  let promised_paths = collect_promised_file_receiver_paths(&pb);
  if !promised_paths.is_empty() {
    return promised_paths;
  }
  collect_legacy_promised_file_paths(drag_info)
}

pub(crate) unsafe fn collect_paths(
  drag_info: &ProtocolObject<dyn NSDraggingInfo>,
  include_promised_files: bool,
) -> Vec<PathBuf> {
  let pb = drag_info.draggingPasteboard();
  let mut drag_drop_paths = collect_file_paths(&pb);
  if drag_drop_paths.is_empty() && include_promised_files {
    drag_drop_paths = collect_promised_file_paths(drag_info);
  }
  if drag_drop_paths.is_empty() {
    if let Some(path) = collect_temp_image_path(&pb) {
      drag_drop_paths.push(path);
    }
  }
  drag_drop_paths
}

pub(crate) fn dragging_entered(
  this: &WryWebView,
  drag_info: &ProtocolObject<dyn NSDraggingInfo>,
) -> NSDragOperation {
  let paths = unsafe { collect_paths(drag_info, false) };
  let dl: NSPoint = drag_info.draggingLocation();
  let frame: NSRect = this.frame();
  let position = (dl.x as i32, (frame.size.height - dl.y) as i32);

  let listener = &this.ivars().drag_drop_handler;
  if !listener(DragDropEvent::Enter { paths, position }) {
    // Reject the Wry file drop (invoke the OS default behaviour)
    unsafe { objc2::msg_send![super(this), draggingEntered: drag_info] }
  } else {
    NSDragOperation::Copy
  }
}

pub(crate) fn dragging_updated(
  this: &WryWebView,
  drag_info: &ProtocolObject<dyn NSDraggingInfo>,
) -> NSDragOperation {
  let dl: NSPoint = drag_info.draggingLocation();
  let frame: NSRect = this.frame();
  let position = (dl.x as i32, (frame.size.height - dl.y) as i32);

  let listener = &this.ivars().drag_drop_handler;
  if !listener(DragDropEvent::Over { position }) {
    unsafe {
      let os_operation = objc2::msg_send![super(this), draggingUpdated: drag_info];
      if os_operation == NSDragOperation::None {
        // 0 will be returned for a drop on any arbitrary location on the webview.
        // We'll override that with NSDragOperationCopy.
        NSDragOperation::Copy
      } else {
        // A different NSDragOperation is returned when a file is hovered over something like
        // a <input type="file">, so we'll make sure to preserve that behaviour.
        os_operation
      }
    }
  } else {
    NSDragOperation::Copy
  }
}

pub(crate) fn perform_drag_operation(
  this: &WryWebView,
  drag_info: &ProtocolObject<dyn NSDraggingInfo>,
) -> Bool {
  let paths = unsafe { collect_paths(drag_info, true) };
  let dl: NSPoint = drag_info.draggingLocation();
  let frame: NSRect = this.frame();
  let position = (dl.x as i32, (frame.size.height - dl.y) as i32);

  let listener = &this.ivars().drag_drop_handler;
  if !listener(DragDropEvent::Drop { paths, position }) {
    // Reject the Wry drop (invoke the OS default behaviour)
    unsafe { objc2::msg_send![super(this), performDragOperation: drag_info] }
  } else {
    Bool::YES
  }
}

pub(crate) fn dragging_exited(this: &WryWebView, drag_info: &ProtocolObject<dyn NSDraggingInfo>) {
  let listener = &this.ivars().drag_drop_handler;
  if !listener(DragDropEvent::Leave) {
    // Reject the Wry drop (invoke the OS default behaviour)
    unsafe { objc2::msg_send![super(this), draggingExited: drag_info] }
  }
}
