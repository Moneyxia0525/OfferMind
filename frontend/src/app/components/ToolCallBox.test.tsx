import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { ToolCallBox } from "@/app/components/ToolCallBox";
import type { PendingApproval, ToolCall } from "@/app/types/types";

// Note: ToolCallBox no longer imports MarkdownContent (args/result render in
// plain <pre> blocks since the toolErrors refactor), so no stub is needed.

function call(overrides: Partial<ToolCall> = {}): ToolCall {
  return {
    id: "tc-1",
    name: "internet_search",
    args: { query: "acme corp" },
    status: "completed",
    ...overrides,
  };
}

describe("ToolCallBox", () => {
  it("renders a pending call with the running spinner and no status chip", () => {
    const { container } = render(<ToolCallBox toolCall={call({ status: "pending" })} />);

    expect(screen.getByText("internet_search")).toBeInTheDocument();
    // getStatusMeta labels pending as "运行中" but with showLabel: false, so
    // the only running indicator is the spinning rail node — no chip text.
    expect(container.querySelector(".animate-spin")).not.toBeNull();
    expect(screen.queryByText("运行中")).not.toBeInTheDocument();
    expect(screen.queryByText(/^错误/)).not.toBeInTheDocument();
    expect(screen.queryByText("失败")).not.toBeInTheDocument();
    expect(screen.queryByText("待审核")).not.toBeInTheDocument();
  });

  it("shows a parsed error chip when a completed result carries an error payload", () => {
    render(
      <ToolCallBox
        toolCall={call({
          status: "completed",
          result: "Error: {'error': {'code': 429, 'message': 'rate limited'}}",
        })}
      />
    );

    expect(screen.getByText("错误 429")).toBeInTheDocument();
    expect(screen.getByTitle("错误 429")).toBeInTheDocument();
  });

  it("shows the needs-review chip for an interrupted call", () => {
    render(<ToolCallBox toolCall={call({ status: "interrupted" })} />);

    expect(screen.getByText("待审核")).toBeInTheDocument();
  });

  it("shows the Failed chip for an error status without a parsable error payload", () => {
    render(<ToolCallBox toolCall={call({ status: "error", result: "boom" })} />);

    expect(screen.getByText("失败")).toBeInTheDocument();
  });

  it("truncates long values in the collapsed preview and expands args on header click", async () => {
    const user = userEvent.setup();
    const args = { content: "A".repeat(150) };
    const expectedPreview = `${JSON.stringify(args).slice(0, 96)}...`;
    render(<ToolCallBox toolCall={call({ name: "write_file", args, result: undefined })} />);

    // Collapsed: previewValue truncates the stringified args to 96 chars + "...".
    expect(screen.getByText(expectedPreview)).toBeInTheDocument();
    expect(screen.queryByText("参数")).not.toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: /write_file/ }));

    expect(screen.getByText("参数")).toBeInTheDocument();
    expect(screen.queryByText(expectedPreview)).not.toBeInTheDocument();

    // Individual args are collapsed behind their key; clicking reveals the full value.
    await user.click(screen.getByRole("button", { name: "content" }));
    expect(screen.getByText("A".repeat(150))).toBeInTheDocument();
  });

  it("renders the result section when expanded", async () => {
    const user = userEvent.setup();
    render(<ToolCallBox toolCall={call({ args: {}, result: "done ok" })} />);

    // Completed without an error renders no chip at all.
    expect(screen.queryByText("已完成")).not.toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: /internet_search/ }));

    expect(screen.getByText("结果")).toBeInTheDocument();
    expect(screen.getByText("done ok")).toBeInTheDocument();
  });

  it("starts expanded with the approval UI when an approval is present", async () => {
    const user = userEvent.setup();
    const onDecide = vi.fn();
    const approval: PendingApproval = {
      key: "int1:0",
      interruptId: "int1",
      index: 0,
      total: 1,
      actionRequest: {
        name: "write_file",
        args: { path: "/tmp/draft.md" },
        description: "Write the draft",
      },
    };
    render(
      <ToolCallBox
        toolCall={call({ name: "write_file", status: "interrupted", args: { path: "/tmp/x" } })}
        approval={approval}
        onDecide={onDecide}
      />
    );

    // Expanded immediately — no click needed — and the approval region renders.
    expect(screen.getByText("需要审批")).toBeInTheDocument();
    expect(screen.getByText("Write the draft")).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "批准" }));
    expect(onDecide).toHaveBeenCalledWith(approval, { type: "approve" });
  });

  it("expands when an approval arrives after mounting as pending", () => {
    const onDecide = vi.fn();
    const pendingCall = call({ name: "execute", status: "pending", args: { command: "id" } });
    const { rerender } = render(<ToolCallBox toolCall={pendingCall} onDecide={onDecide} />);

    expect(screen.queryByText("需要审批")).not.toBeInTheDocument();

    const approval: PendingApproval = {
      key: "int1:0",
      interruptId: "int1",
      index: 0,
      total: 1,
      actionRequest: { name: "execute", args: { command: "id" } },
    };
    rerender(
      <ToolCallBox
        toolCall={call({ name: "execute", status: "interrupted", args: { command: "id" } })}
        approval={approval}
        onDecide={onDecide}
      />
    );

    expect(screen.getByText("需要审批")).toBeInTheDocument();
  });

  it.each([
    "read_file",
    "write_todos",
    "ls",
    "execute",
    "grep_search",
    "generate_social_image",
    "task",
    "fetch_url",
    "mcp_lookup",
    "totally_unknown_tool",
  ])("renders the %s tool header with an icon without crashing", (name) => {
    const { container } = render(
      <ToolCallBox toolCall={call({ name, args: { input: "x" }, result: "ok" })} />
    );

    expect(screen.getByText(name)).toBeInTheDocument();
    expect(container.querySelector("svg")).not.toBeNull();
  });
});
