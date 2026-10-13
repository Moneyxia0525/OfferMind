import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { ToolApprovalInterrupt } from "@/app/components/ToolApprovalInterrupt";
import type { ActionRequest, ApprovalDecision, ReviewConfig } from "@/app/types/types";

const actionRequest: ActionRequest = {
  name: "write_file",
  args: { path: "/tmp/draft.md", content: "hello" },
  description: "The agent wants to write the draft file.",
};

function renderInterrupt(
  props: {
    onDecide?: (decision: ApprovalDecision) => void;
    reviewConfig?: ReviewConfig;
    isLoading?: boolean;
    request?: ActionRequest;
    queuedDecision?: ApprovalDecision;
    queueNote?: string;
  } = {}
) {
  const onDecide = props.onDecide ?? vi.fn();
  render(
    <ToolApprovalInterrupt
      actionRequest={props.request ?? actionRequest}
      reviewConfig={props.reviewConfig}
      onDecide={onDecide}
      queuedDecision={props.queuedDecision}
      queueNote={props.queueNote}
      isLoading={props.isLoading}
    />
  );
  return { onDecide };
}

describe("ToolApprovalInterrupt", () => {
  it("renders the header, description, tool name and current arguments", () => {
    renderInterrupt();

    expect(screen.getByText("需要审批")).toBeInTheDocument();
    expect(screen.getByText("The agent wants to write the draft file.")).toBeInTheDocument();
    expect(screen.getByText("write_file")).toBeInTheDocument();
    expect(screen.getByText(/"path": "\/tmp\/draft\.md"/)).toBeInTheDocument();
  });

  it("emits a single approve decision when the approve action is clicked", async () => {
    const user = userEvent.setup();
    const { onDecide } = renderInterrupt();

    await user.click(screen.getByRole("button", { name: "批准" }));

    // One bare decision — the owning hook batches siblings into the resume.
    expect(onDecide).toHaveBeenCalledTimes(1);
    expect(onDecide).toHaveBeenCalledWith({ type: "approve" });
  });

  it("reveals the rejection message input first, then confirms with the trimmed message", async () => {
    const user = userEvent.setup();
    const { onDecide } = renderInterrupt();

    await user.click(screen.getByRole("button", { name: "拒绝" }));
    // First click only reveals the input; nothing is decided yet.
    expect(onDecide).not.toHaveBeenCalled();
    expect(screen.getByText("拒绝原因（可选）")).toBeInTheDocument();

    const textarea = screen.getByPlaceholderText("请说明拒绝此操作的原因……");
    await user.type(textarea, "  too risky  ");
    await user.click(screen.getByRole("button", { name: "确认拒绝" }));

    expect(onDecide).toHaveBeenCalledWith({ type: "reject", message: "too risky" });
  });

  it("cancels the rejection flow and returns to the decision buttons", async () => {
    const user = userEvent.setup();
    const { onDecide } = renderInterrupt();

    await user.click(screen.getByRole("button", { name: "拒绝" }));
    await user.click(screen.getByRole("button", { name: "取消" }));

    expect(onDecide).not.toHaveBeenCalled();
    expect(screen.queryByText("拒绝原因（可选）")).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "批准" })).toBeInTheDocument();
  });

  it("edits arguments and submits an edit decision with the edited_action", async () => {
    const user = userEvent.setup();
    const { onDecide } = renderInterrupt();

    await user.click(screen.getByRole("button", { name: "编辑" }));
    expect(screen.getByText("编辑参数")).toBeInTheDocument();

    const [pathField, contentField] = screen.getAllByRole("textbox") as HTMLTextAreaElement[];
    expect(pathField).toHaveValue("/tmp/draft.md");
    expect(contentField).toHaveValue("hello");

    await user.clear(pathField);
    await user.type(pathField, "notes/final.md");
    await user.click(screen.getByRole("button", { name: "保存并批准" }));

    expect(onDecide).toHaveBeenCalledWith({
      type: "edit",
      edited_action: {
        name: "write_file",
        args: { path: "notes/final.md", content: "hello" },
      },
    });
  });

  it("parses JSON-looking edited values into objects", async () => {
    const user = userEvent.setup();
    const { onDecide } = renderInterrupt();

    await user.click(screen.getByRole("button", { name: "编辑" }));
    const [, contentField] = screen.getAllByRole("textbox");

    await user.clear(contentField);
    await user.click(contentField);
    await user.paste('{"tone": "formal"}');
    await user.click(screen.getByRole("button", { name: "保存并批准" }));

    expect(onDecide).toHaveBeenCalledWith({
      type: "edit",
      edited_action: {
        name: "write_file",
        args: { path: "/tmp/draft.md", content: { tone: "formal" } },
      },
    });
  });

  it("hides reject and edit when the review config only allows approve", () => {
    // Wire shape from the middleware is snake_case.
    renderInterrupt({
      reviewConfig: { action_name: "write_file", allowed_decisions: ["approve"] },
    });

    expect(screen.getByRole("button", { name: "批准" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "拒绝" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "编辑" })).not.toBeInTheDocument();
  });

  it("disables all controls while loading", () => {
    renderInterrupt({ isLoading: true });

    // The approve button swaps its label while loading.
    expect(screen.getByRole("button", { name: "批准中…" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "拒绝" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "编辑" })).toBeDisabled();
  });

  it("replaces the buttons with a queued chip once this action is decided", () => {
    const { onDecide } = renderInterrupt({
      queuedDecision: { type: "approve" },
      queueNote: "还需等待 1 个决定",
    });

    expect(screen.getByText("已批准 — 已排队")).toBeInTheDocument();
    expect(screen.getByText("还需等待 1 个决定")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "批准" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "拒绝" })).not.toBeInTheDocument();
    expect(onDecide).not.toHaveBeenCalled();
  });
});
