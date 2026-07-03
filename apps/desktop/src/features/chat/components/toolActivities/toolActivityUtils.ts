import type { AgentToolCall, AgentToolResult } from "@agent";

export function formatToolDetails(value: unknown) {
  if (typeof value === "string") return value;

  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return String(value);
  }
}

export function getToolDisplayName(tool: string) {
  const labels: Record<string, string> = {
    apply_patch: "应用修改",
    attachments_list: "列出对话附件",
    attachments_list_project: "列出项目附件",
    generate_patch: "生成修改",
    git_diff: "读取 Git diff",
    read_file: "读取文件",
    read_image: "读取图片",
    read_pdf: "读取 PDF",
    read_presentation: "读取演示文稿",
    read_spreadsheet: "读取表格",
    read_word: "读取文档",
    run_command: "运行命令",
    search_code: "搜索代码",
    search_files: "列出文件",
    web_fetch: "读取网页",
    web_search: "联网搜索",
  };

  return labels[tool] ?? tool;
}

export function getToolCallLabel(call: AgentToolCall, result?: AgentToolResult) {
  const name = getToolDisplayName(call.tool);

  if (!result) {
    return call.approvalStatus === "required" ? `等待审批 ${name}` : `正在${name}`;
  }

  if (!result.ok) {
    return `${name}失败`;
  }

  return `已${name}`;
}
