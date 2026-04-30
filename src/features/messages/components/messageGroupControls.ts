export type MessageGroupControlsApi = {
  hasAnyGroups: boolean;
  canExpandAny: boolean;
  canCollapseAny: boolean;
  expandAll: () => void;
  collapseAll: () => void;
};
