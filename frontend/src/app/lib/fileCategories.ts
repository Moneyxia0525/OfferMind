export type FileCategory = {
  prefix: string;
  label: string;
  iconVar: string;
};

export const FILE_CATEGORIES: readonly FileCategory[] = [
  {
    prefix: "tailored_resume",
    label: "定制简历",
    iconVar: "var(--color-primary)",
  },
  {
    prefix: "interview_battlecard",
    label: "面试速查卡",
    iconVar: "var(--color-warning)",
  },
  {
    prefix: "interview_coach",
    label: "面试准备",
    iconVar: "var(--color-category-plum)",
  },
  {
    prefix: "research",
    label: "调研",
    iconVar: "var(--color-category-slate)",
  },
  {
    prefix: "processed",
    label: "已处理",
    iconVar: "var(--color-category-sage)",
  },
  {
    prefix: "upload",
    label: "上传",
    iconVar: "var(--color-category-rose)",
  },
  {
    prefix: "charts",
    label: "图表",
    iconVar: "var(--color-category-indigo)",
  },
  {
    prefix: "reports",
    label: "报告",
    iconVar: "var(--color-category-amber)",
  },
] as const;

export function getFileCategory(virtualPath: string): FileCategory | null {
  const trimmed = virtualPath.replace(/^\/+/, "");
  const head = trimmed.split("/", 1)[0];
  if (!head) return null;
  return FILE_CATEGORIES.find((c) => c.prefix === head) ?? null;
}

export function splitFilePath(virtualPath: string): { prefix: string; basename: string } {
  const lastSlash = virtualPath.lastIndexOf("/");
  if (lastSlash === -1) return { prefix: "", basename: virtualPath };
  return {
    prefix: virtualPath.slice(0, lastSlash + 1),
    basename: virtualPath.slice(lastSlash + 1),
  };
}

export function splitBasename(basename: string): { stem: string; ext: string } {
  const dot = basename.lastIndexOf(".");
  if (dot <= 0 || dot === basename.length - 1) return { stem: basename, ext: "" };
  return { stem: basename.slice(0, dot), ext: basename.slice(dot) };
}
