import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { TopBar } from "@/app/components/TopBar";

vi.mock("next-themes", () => ({ useTheme: () => ({ resolvedTheme: "light", setTheme: vi.fn() }) }));
vi.mock("@/providers/ChatProvider", () => ({ useChatContext: () => ({ messages: [] }) }));
vi.mock("@/app/components/auth/UserMenu", () => ({ UserMenu: () => null }));

function renderBar(props: Partial<React.ComponentProps<typeof TopBar>> = {}) {
  const onSelectAgent = props.onSelectAgent ?? vi.fn();
  render(
    <TopBar
      threadId={null}
      interruptCount={0}
      threadsOpen={false}
      onToggleThreads={vi.fn()}
      onOpenSettings={vi.fn()}
      onNewThread={vi.fn()}
      activeAgentId="career_agent"
      agentAvailability={{}}
      {...props}
      onSelectAgent={onSelectAgent}
    />
  );
  return { onSelectAgent };
}

describe("TopBar agent picker", () => {
  it("names the active agent on the pill", () => {
    renderBar({ activeAgentId: "analytics_agent" });

    expect(screen.getByRole("button", { name: /数据分析助手/ })).toBeInTheDocument();
  });

  it("switches agent when another is chosen", async () => {
    const { onSelectAgent } = renderBar();

    await userEvent.click(screen.getByRole("button", { name: /求职助手/ }));
    await userEvent.click(screen.getByRole("menuitem", { name: /数据分析助手/ }));

    expect(onSelectAgent).toHaveBeenCalledWith("analytics_agent");
  });

  it("does not re-select the agent already active", async () => {
    const { onSelectAgent } = renderBar();

    await userEvent.click(screen.getByRole("button", { name: /求职助手/ }));
    await userEvent.click(screen.getByRole("menuitem", { name: /求职助手/ }));

    expect(onSelectAgent).not.toHaveBeenCalled();
  });

  it("disables an agent this user may not run, and says why", async () => {
    const { onSelectAgent } = renderBar({ agentAvailability: { analytics_agent: false } });

    await userEvent.click(screen.getByRole("button", { name: /求职助手/ }));
    const row = screen.getByRole("menuitem", { name: /数据分析助手/ });

    expect(row).toBeDisabled();
    expect(row).toHaveTextContent("仅管理员可用");
    await userEvent.click(row);
    expect(onSelectAgent).not.toHaveBeenCalled();
  });

  it("shows the career agent's specialists only under the career agent", async () => {
    const { rerender } = render(
      <TopBar
        threadId={null}
        interruptCount={0}
        threadsOpen={false}
        onToggleThreads={vi.fn()}
        onOpenSettings={vi.fn()}
        onNewThread={vi.fn()}
        activeAgentId="career_agent"
        agentAvailability={{}}
        onSelectAgent={vi.fn()}
      />
    );
    await userEvent.click(screen.getByRole("button", { name: /求职助手/ }));
    expect(screen.getByText("简历优化")).toBeInTheDocument();

    rerender(
      <TopBar
        threadId={null}
        interruptCount={0}
        threadsOpen={false}
        onToggleThreads={vi.fn()}
        onOpenSettings={vi.fn()}
        onNewThread={vi.fn()}
        activeAgentId="analytics_agent"
        agentAvailability={{}}
        onSelectAgent={vi.fn()}
      />
    );
    expect(screen.queryByText("简历优化")).not.toBeInTheDocument();
  });
});
