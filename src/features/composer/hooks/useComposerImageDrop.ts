import { useEffect, useRef, useState } from "react";
import { subscribeWindowDragDrop } from "../../../services/dragDrop";

const imageExtensions = [
  ".png",
  ".jpg",
  ".jpeg",
  ".gif",
  ".webp",
  ".bmp",
  ".tiff",
  ".tif",
  ".heic",
  ".heif",
];

function isImagePath(path: string) {
  const lower = path.toLowerCase();
  return imageExtensions.some((ext) => lower.endsWith(ext));
}

function isImageFile(file: File & { path?: string }) {
  if (typeof file.type === "string" && file.type.startsWith("image/")) {
    return true;
  }
  if (typeof file.path === "string" && file.path.trim() && isImagePath(file.path.trim())) {
    return true;
  }
  return typeof file.name === "string" && isImagePath(file.name);
}

function isDragFileTransfer(types: readonly string[] | undefined) {
  if (!types || types.length === 0) {
    return false;
  }
  return (
    types.includes("Files") ||
    types.includes("public.file-url") ||
    types.includes("application/x-moz-file")
  );
}

function readFilesAsDataUrls(files: File[]) {
  return Promise.all(
    files.map(
      (file) =>
        new Promise<string>((resolve) => {
          const reader = new FileReader();
          reader.onload = () =>
            resolve(typeof reader.result === "string" ? reader.result : "");
          reader.onerror = () => resolve("");
          reader.readAsDataURL(file);
        }),
    ),
  ).then((items) => items.filter(Boolean));
}

function getDragPosition(position: { x: number; y: number }) {
  return position;
}

function buildDragPositionCandidates(
  position: { x: number; y: number },
  lastClientPosition: { x: number; y: number } | null,
) {
  const scale = window.devicePixelRatio || 1;
  const candidates: Array<{ x: number; y: number }> = [getDragPosition(position)];
  if (scale !== 1) {
    candidates.push({ x: position.x / scale, y: position.y / scale });
  }
  if (scale !== 1 && lastClientPosition) {
    const logicalDistance = Math.hypot(
      position.x - lastClientPosition.x,
      position.y - lastClientPosition.y,
    );
    const scaled = { x: position.x / scale, y: position.y / scale };
    const scaledDistance = Math.hypot(
      scaled.x - lastClientPosition.x,
      scaled.y - lastClientPosition.y,
    );
    if (scaledDistance < logicalDistance) {
      candidates.unshift(scaled);
    }
  }
  return candidates.filter(
    (candidate, index, list) =>
      list.findIndex(
        (entry) => entry.x === candidate.x && entry.y === candidate.y,
      ) === index,
  );
}

function isPositionInsideRect(position: { x: number; y: number }, rect: DOMRect) {
  return (
    position.x >= rect.left &&
    position.x <= rect.right &&
    position.y >= rect.top &&
    position.y <= rect.bottom
  );
}

function targetContainsActiveElement(target: HTMLElement) {
  const activeElement = document.activeElement;
  return activeElement instanceof Node && target.contains(activeElement);
}

function isNativeDropInsideTarget(
  target: HTMLElement,
  position: { x: number; y: number },
  lastClientPosition: { x: number; y: number } | null,
) {
  const rect = target.getBoundingClientRect();
  const candidates = buildDragPositionCandidates(position, lastClientPosition);
  if (candidates.some((candidate) => isPositionInsideRect(candidate, rect))) {
    return true;
  }
  if (
    typeof document.elementFromPoint === "function" &&
    candidates.some((candidate) => {
      const element = document.elementFromPoint(candidate.x, candidate.y);
      return element instanceof Node && target.contains(element);
    })
  ) {
    return true;
  }
  return targetContainsActiveElement(target);
}

type UseComposerImageDropArgs = {
  disabled: boolean;
  onAttachImages?: (paths: string[]) => void;
};

export function useComposerImageDrop({
  disabled,
  onAttachImages,
}: UseComposerImageDropArgs) {
  const [isDragOver, setIsDragOver] = useState(false);
  const dropTargetRef = useRef<HTMLDivElement | null>(null);
  const lastClientPositionRef = useRef<{ x: number; y: number } | null>(null);

  useEffect(() => {
    let unlisten: (() => void) | null = null;
    if (disabled) {
      return undefined;
    }
    unlisten = subscribeWindowDragDrop((event) => {
      const target = dropTargetRef.current;
      if (!target) {
        return;
      }
      const imagePaths = (event.payload.paths ?? [])
        .map((path) => path.trim())
        .filter(Boolean)
        .filter(isImagePath);
      if (event.payload.type === "leave") {
        setIsDragOver(false);
        return;
      }
      if (imagePaths.length > 0) {
        if (event.payload.type === "over" || event.payload.type === "enter") {
          setIsDragOver(true);
          return;
        }
        if (event.payload.type === "drop") {
          setIsDragOver(false);
          onAttachImages?.(imagePaths);
          return;
        }
      }
      const isInside = isNativeDropInsideTarget(
        target,
        event.payload.position,
        lastClientPositionRef.current,
      );
      if (event.payload.type === "over" || event.payload.type === "enter") {
        setIsDragOver(isInside);
        return;
      }
      if (event.payload.type === "drop") {
        setIsDragOver(false);
        if (!isInside) {
          return;
        }
        if (imagePaths.length > 0) {
          onAttachImages?.(imagePaths);
        }
      }
    });
    return () => {
      if (unlisten) {
        unlisten();
      }
    };
  }, [disabled, onAttachImages]);

  const handleDragOver = (event: React.DragEvent<HTMLElement>) => {
    if (disabled) {
      return;
    }
    if (isDragFileTransfer(event.dataTransfer?.types)) {
      lastClientPositionRef.current = { x: event.clientX, y: event.clientY };
      event.preventDefault();
      setIsDragOver(true);
    }
  };

  const handleDragEnter = (event: React.DragEvent<HTMLElement>) => {
    handleDragOver(event);
  };

  const handleDragLeave = () => {
    if (isDragOver) {
      setIsDragOver(false);
      lastClientPositionRef.current = null;
    }
  };

  const handleDrop = async (event: React.DragEvent<HTMLElement>) => {
    if (disabled) {
      return;
    }
    event.preventDefault();
    setIsDragOver(false);
    lastClientPositionRef.current = null;
    const files = Array.from(event.dataTransfer?.files ?? []);
    const items = Array.from(event.dataTransfer?.items ?? []);
    const itemFiles = items
      .filter((item) => item.kind === "file")
      .map((item) => item.getAsFile())
      .filter((file): file is File => Boolean(file));
    const filePaths = [...files, ...itemFiles]
      .map((file) => (file as File & { path?: string }).path ?? "")
      .filter(Boolean);
    const imagePaths = filePaths.filter(isImagePath);
    if (imagePaths.length > 0) {
      onAttachImages?.(imagePaths);
      return;
    }
    const fileImages = [...files, ...itemFiles].filter((file) =>
      isImageFile(file as File & { path?: string }),
    );
    if (fileImages.length === 0) {
      return;
    }
    const dataUrls = await readFilesAsDataUrls(fileImages);
    if (dataUrls.length > 0) {
      onAttachImages?.(dataUrls);
    }
  };

  const handlePaste = async (event: React.ClipboardEvent<HTMLTextAreaElement>) => {
    if (disabled) {
      return;
    }
    const items = Array.from(event.clipboardData?.items ?? []);
    const imageItems = items.filter((item) => item.type.startsWith("image/"));
    if (imageItems.length === 0) {
      return;
    }
    event.preventDefault();
    const files = imageItems
      .map((item) => item.getAsFile())
      .filter((file): file is File => Boolean(file));
    if (!files.length) {
      return;
    }
    const dataUrls = await Promise.all(
      files.map(
        (file) =>
          new Promise<string>((resolve) => {
            const reader = new FileReader();
            reader.onload = () =>
              resolve(typeof reader.result === "string" ? reader.result : "");
            reader.onerror = () => resolve("");
            reader.readAsDataURL(file);
          }),
      ),
    );
    const valid = dataUrls.filter(Boolean);
    if (valid.length > 0) {
      onAttachImages?.(valid);
    }
  };

  return {
    dropTargetRef,
    isDragOver,
    handleDragOver,
    handleDragEnter,
    handleDragLeave,
    handleDrop,
    handlePaste,
  };
}
