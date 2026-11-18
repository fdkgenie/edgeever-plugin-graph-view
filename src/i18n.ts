export type GraphLocale = "en" | "zh-CN" | "vi";

export interface GraphCopy {
  pluginName: string;
  commandOpenGlobal: string;
  commandOpenLocal: string;
  panelTitle: string;
  panelDescription: string;
  tabGlobal: string;
  tabLocal: string;
  searchPlaceholder: string;
  depthLabel: string;
  directionLabel: string;
  directionBoth: string;
  directionOutgoing: string;
  directionIncoming: string;
  actionAnimate: string;
  actionStopAnimate: string;
  actionFit: string;
  actionRefresh: string;
  actionControls: string;
  actionZoomIn: string;
  actionZoomOut: string;
  actionReheat: string;
  sectionLocalTarget: string;
  localTargetCurrent: string;
  localTargetPlaceholder: string;
  localNoTarget: string;
  sectionFilters: string;
  filterTags: string;
  filterAttachments: string;
  filterExistingOnly: string;
  filterOrphans: string;
  filterExcluded: string;
  filterExcludedPlaceholder: string;
  sectionGroups: string;
  groupPlaceholder: string;
  groupAdd: string;
  groupMoveUp: string;
  groupMoveDown: string;
  groupDelete: string;
  groupColorLabel: string;
  sectionDisplay: string;
  displayArrows: string;
  displayTextFade: string;
  displayNodeSize: string;
  displayLinkThickness: string;
  sectionForces: string;
  forceCenter: string;
  forceRepel: string;
  forceLink: string;
  forceDistance: string;
  forcesReset: string;
  sectionNodes: string;
  nodesCountLabel: (visible: number, total: number) => string;
  statsLabel: (nodes: number, edges: number) => string;
  connectionsLabel: (inCount: number, outCount: number) => string;
  openNoteAction: string;
  focusLocalAction: string;
  unresolvedBadge: string;
  tagBadge: string;
  attachmentBadge: string;
  untitledNote: string;
  emptyTitle: string;
  emptyDescription: string;
  emptyFilteredTitle: string;
  emptyFilteredDescription: string;
  emptyResetAction: string;
  loadingLabel: string;
  timelapseProgress: (current: number, total: number, dateLabel: string) => string;
  keyboardHelp: string;
  canvasAriaLabel: string;
  noticeNoActiveNote: string;
  noticeUnresolvedNote: string;
  noticeRefreshFailed: (message: string) => string;
  sidebarAriaLabel: string;
}

const EN_COPY: GraphCopy = {
  pluginName: "Graph View",
  commandOpenGlobal: "Open Graph View",
  commandOpenLocal: "Open Local Graph",
  panelTitle: "Graph View",
  panelDescription: "Visualize connections across notes, tags, and attachments.",
  tabGlobal: "Global",
  tabLocal: "Local",
  searchPlaceholder: "Search (tag:, path:, file:, kind:, -exclude, OR)",
  depthLabel: "Depth",
  directionLabel: "Links",
  directionBoth: "All",
  directionOutgoing: "Outgoing",
  directionIncoming: "Incoming",
  actionAnimate: "Animate",
  actionStopAnimate: "Stop",
  actionFit: "Fit view",
  actionRefresh: "Refresh",
  actionControls: "Settings",
  actionZoomIn: "Zoom in",
  actionZoomOut: "Zoom out",
  actionReheat: "Re-layout physics",
  sectionLocalTarget: "Local Focus",
  localTargetCurrent: "Active note",
  localTargetPlaceholder: "Select focus note...",
  localNoTarget: "Open or select a note to inspect its local connections.",
  sectionFilters: "Filters",
  filterTags: "Tags",
  filterAttachments: "Attachments",
  filterExistingOnly: "Existing files only",
  filterOrphans: "Orphans",
  filterExcluded: "Excluded patterns",
  filterExcludedPlaceholder: "Archive/, tag:#draft",
  sectionGroups: "Groups",
  groupPlaceholder: "Query (e.g. tag:#project)",
  groupAdd: "New group",
  groupMoveUp: "Move group up",
  groupMoveDown: "Move group down",
  groupDelete: "Remove group",
  groupColorLabel: "Group color",
  sectionDisplay: "Display",
  displayArrows: "Arrows",
  displayTextFade: "Text fade threshold",
  displayNodeSize: "Node size",
  displayLinkThickness: "Link thickness",
  sectionForces: "Forces",
  forceCenter: "Center force",
  forceRepel: "Repel force",
  forceLink: "Link force",
  forceDistance: "Link distance",
  forcesReset: "Restore defaults",
  sectionNodes: "Visible Nodes",
  nodesCountLabel: (visible, total) => `${visible} of ${total} indexed notes`,
  statsLabel: (nodes, edges) => `${nodes} nodes · ${edges} links`,
  connectionsLabel: (inCount, outCount) => `${inCount} incoming · ${outCount} outgoing`,
  openNoteAction: "Open note",
  focusLocalAction: "Local graph",
  unresolvedBadge: "Unresolved link",
  tagBadge: "Tag",
  attachmentBadge: "Attachment",
  untitledNote: "Untitled note",
  emptyTitle: "No notes indexed yet",
  emptyDescription: "Create notes and link them with @mentions or [[WikiLinks]] to build your knowledge graph.",
  emptyFilteredTitle: "No nodes match the current filters",
  emptyFilteredDescription: "Adjust the search query, filters, or local depth to reveal connected notes.",
  emptyResetAction: "Reset filters",
  loadingLabel: "Indexing workspace graph…",
  timelapseProgress: (current, total, dateLabel) => `${current}/${total} · ${dateLabel}`,
  keyboardHelp: "Drag to pan or move node · Scroll to zoom · Arrows pan · [ ] cycle · Enter opens",
  canvasAriaLabel: "Interactive knowledge graph canvas",
  noticeNoActiveNote: "Showing Local Graph — choose a note from Local Focus or open a note first.",
  noticeUnresolvedNote: "This WikiLink points to a note that does not exist yet.",
  noticeRefreshFailed: (message) => `Graph refresh failed: ${message}`,
  sidebarAriaLabel: "Graph controls",
};

const ZH_CN_COPY: GraphCopy = {
  pluginName: "关系图谱",
  commandOpenGlobal: "打开关系图谱",
  commandOpenLocal: "打开局部图谱",
  panelTitle: "关系图谱",
  panelDescription: "可视化笔记、标签与附件之间的知识连接网络。",
  tabGlobal: "全局图谱",
  tabLocal: "局部图谱",
  searchPlaceholder: "搜索（tag:、path:、file:、kind:、-排除、OR）",
  depthLabel: "深度",
  directionLabel: "方向",
  directionBoth: "全部",
  directionOutgoing: "出链",
  directionIncoming: "入链",
  actionAnimate: "时间轴动画",
  actionStopAnimate: "停止动画",
  actionFit: "适应画布",
  actionRefresh: "刷新索引",
  actionControls: "图谱控制",
  actionZoomIn: "放大",
  actionZoomOut: "缩小",
  actionReheat: "重新布局",
  sectionLocalTarget: "局部焦点",
  localTargetCurrent: "焦点笔记",
  localTargetPlaceholder: "选择焦点笔记...",
  localNoTarget: "打开或在下方选择一条笔记以查看其局部邻域连接。",
  sectionFilters: "筛选器",
  filterTags: "标签",
  filterAttachments: "附件",
  filterExistingOnly: "仅显示已存在笔记",
  filterOrphans: "孤立笔记",
  filterExcluded: "排除规则",
  filterExcludedPlaceholder: "Archive/, tag:#draft",
  sectionGroups: "分组着色",
  groupPlaceholder: "查询规则（例如 tag:#project）",
  groupAdd: "新建分组",
  groupMoveUp: "上移分组",
  groupMoveDown: "下移分组",
  groupDelete: "删除分组",
  groupColorLabel: "分组颜色",
  sectionDisplay: "显示",
  displayArrows: "方向箭头",
  displayTextFade: "文字淡出阈值",
  displayNodeSize: "节点大小",
  displayLinkThickness: "连线粗细",
  sectionForces: "力学参数",
  forceCenter: "向心力",
  forceRepel: "排斥力",
  forceLink: "连接引力",
  forceDistance: "连接距离",
  forcesReset: "恢复默认",
  sectionNodes: "可见节点",
  nodesCountLabel: (visible, total) => `当前显示 ${visible} 个节点（共索引 ${total} 篇笔记）`,
  statsLabel: (nodes, edges) => `${nodes} 个节点 · ${edges} 条连接`,
  connectionsLabel: (inCount, outCount) => `${inCount} 入链 · ${outCount} 出链`,
  openNoteAction: "打开笔记",
  focusLocalAction: "局部图谱",
  unresolvedBadge: "未创建链接",
  tagBadge: "标签",
  attachmentBadge: "附件",
  untitledNote: "无标题笔记",
  emptyTitle: "暂无可展示的笔记",
  emptyDescription: "创建笔记并使用 @引用 或 [[双链]] 建立关联后即可查看关系图谱。",
  emptyFilteredTitle: "没有节点符合当前筛选条件",
  emptyFilteredDescription: "尝试放宽搜索条件、筛选开关或增大局部图谱深度。",
  emptyResetAction: "重置筛选",
  loadingLabel: "正在索引笔记网络…",
  timelapseProgress: (current, total, dateLabel) => `${current}/${total} · ${dateLabel}`,
  keyboardHelp: "拖拽平移或移动节点 · 滚轮缩放 · 方向键平移 · [ ] 切换节点 · Enter 打开",
  canvasAriaLabel: "交互式知识图谱画布",
  noticeNoActiveNote: "已打开局部图谱，请在右侧选择一条焦点笔记。",
  noticeUnresolvedNote: "该双链指向的笔记尚未创建。",
  noticeRefreshFailed: (message) => `图谱刷新失败：${message}`,
  sidebarAriaLabel: "图谱控制面板",
};

const VI_COPY: GraphCopy = {
  pluginName: "Biểu đồ liên kết",
  commandOpenGlobal: "Mở Biểu đồ liên kết",
  commandOpenLocal: "Mở Biểu đồ cục bộ",
  panelTitle: "Biểu đồ liên kết",
  panelDescription: "Trực quan hóa mạng lưới liên kết giữa ghi chú, thẻ và tệp đính kèm.",
  tabGlobal: "Toàn cục",
  tabLocal: "Cục bộ",
  searchPlaceholder: "Tìm kiếm (tag:, path:, file:, kind:, -loại trừ, OR)",
  depthLabel: "Độ sâu",
  directionLabel: "Hướng",
  directionBoth: "Tất cả",
  directionOutgoing: "Đi ra",
  directionIncoming: "Đi vào",
  actionAnimate: "Phát tiến trình",
  actionStopAnimate: "Dừng",
  actionFit: "Vừa khung",
  actionRefresh: "Làm mới",
  actionControls: "Cài đặt",
  actionZoomIn: "Phóng to",
  actionZoomOut: "Thu nhỏ",
  actionReheat: "Sắp xếp lại",
  sectionLocalTarget: "Ghi chú trung tâm",
  localTargetCurrent: "Ghi chú đang chọn",
  localTargetPlaceholder: "Chọn ghi chú trung tâm...",
  localNoTarget: "Hãy mở hoặc chọn một ghi chú để xem các kết nối cục bộ.",
  sectionFilters: "Bộ lọc",
  filterTags: "Thẻ",
  filterAttachments: "Tệp đính kèm",
  filterExistingOnly: "Chỉ tệp hiện có",
  filterOrphans: "Ghi chú cô lập",
  filterExcluded: "Mẫu loại trừ",
  filterExcludedPlaceholder: "Archive/, tag:#draft",
  sectionGroups: "Nhóm màu",
  groupPlaceholder: "Truy vấn (vd: tag:#project)",
  groupAdd: "Thêm nhóm",
  groupMoveUp: "Di chuyển lên",
  groupMoveDown: "Di chuyển xuống",
  groupDelete: "Xóa nhóm",
  groupColorLabel: "Màu nhóm",
  sectionDisplay: "Hiển thị",
  displayArrows: "Mũi tên",
  displayTextFade: "Ngưỡng mờ nhãn",
  displayNodeSize: "Kích thước nút",
  displayLinkThickness: "Độ dày liên kết",
  sectionForces: "Lực vật lý",
  forceCenter: "Lực hướng tâm",
  forceRepel: "Lực đẩy",
  forceLink: "Lực kéo liên kết",
  forceDistance: "Khoảng cách liên kết",
  forcesReset: "Khôi phục mặc định",
  sectionNodes: "Nút hiển thị",
  nodesCountLabel: (visible, total) => `${visible} nút hiển thị · ${total} ghi chú đã lập chỉ mục`,
  statsLabel: (nodes, edges) => `${nodes} nút · ${edges} liên kết`,
  connectionsLabel: (inCount, outCount) => `${inCount} đến · ${outCount} đi`,
  openNoteAction: "Mở ghi chú",
  focusLocalAction: "Biểu đồ cục bộ",
  unresolvedBadge: "Liên kết chưa tạo",
  tagBadge: "Thẻ",
  attachmentBadge: "Tệp đính kèm",
  untitledNote: "Ghi chú chưa đặt tên",
  emptyTitle: "Chưa có ghi chú nào",
  emptyDescription: "Tạo ghi chú và kết nối bằng @mention hoặc [[WikiLink]] để xây dựng biểu đồ tri thức.",
  emptyFilteredTitle: "Không có nút nào khớp bộ lọc",
  emptyFilteredDescription: "Thử thay đổi từ khóa tìm kiếm, bộ lọc hoặc tăng độ sâu cục bộ.",
  emptyResetAction: "Đặt lại bộ lọc",
  loadingLabel: "Đang lập chỉ mục biểu đồ…",
  timelapseProgress: (current, total, dateLabel) => `${current}/${total} · ${dateLabel}`,
  keyboardHelp: "Kéo để xoay/di chuyển · Cuộn để thu phóng · Phím mũi tên di chuyển · [ ] chọn nút · Enter để mở",
  canvasAriaLabel: "Khung vẽ biểu đồ tri thức tương tác",
  noticeNoActiveNote: "Đang mở Biểu đồ cục bộ — hãy chọn ghi chú trung tâm ở thanh điều khiển.",
  noticeUnresolvedNote: "WikiLink này trỏ tới một ghi chú chưa được tạo.",
  noticeRefreshFailed: (message) => `Làm mới biểu đồ thất bại: ${message}`,
  sidebarAriaLabel: "Bảng điều khiển biểu đồ",
};

export const detectGraphLocale = (): GraphLocale => {
  const raw = (
    (typeof document !== "undefined" ? document.documentElement?.lang : "")
    || (typeof navigator !== "undefined" ? navigator.language : "")
    || "en"
  ).toLocaleLowerCase();
  if (raw.startsWith("zh")) return "zh-CN";
  if (raw.startsWith("vi")) return "vi";
  return "en";
};

export const getGraphCopy = (locale: GraphLocale = detectGraphLocale()): GraphCopy => {
  if (locale === "zh-CN") return ZH_CN_COPY;
  if (locale === "vi") return VI_COPY;
  return EN_COPY;
};
