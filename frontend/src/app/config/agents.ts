import { BarChart3, Compass, type LucideIcon } from "lucide-react";

/**
 * The agents this deployment can serve, keyed by LangGraph `graph_id`.
 *
 * The backend is the authority on which graphs exist (`LANGSERVE_GRAPHS`) and
 * who may run them (`GET /agents/available`). This registry only carries what
 * the backend has no opinion about: how each agent is named and coloured in the
 * picker. An id that is not listed here is not offered.
 */
export interface AgentMeta {
  graphId: string;
  name: string;
  /** One line, shown under the name in the picker. */
  description: string;
  /** CSS colour for the agent's dot. Career uses the live accent token. */
  color: string;
  icon: LucideIcon;
}

export const CAREER_AGENT_ID = "career_agent";
export const ANALYTICS_AGENT_ID = "analytics_agent";

export const AGENTS: Record<string, AgentMeta> = {
  [CAREER_AGENT_ID]: {
    graphId: CAREER_AGENT_ID,
    name: "求职助手",
    description: "统筹从简历到面试的完整准备流程",
    color: "var(--brand-accent)",
    icon: Compass,
  },
  [ANALYTICS_AGENT_ID]: {
    graphId: ANALYTICS_AGENT_ID,
    name: "数据分析助手",
    description: "回答关于产品使用情况、可靠性和成本的问题",
    color: "#5b5bd6",
    icon: BarChart3,
  },
};

/** Graph ids in picker order. */
export const AGENT_IDS = [CAREER_AGENT_ID, ANALYTICS_AGENT_ID];

export const DEFAULT_AGENT_ID = CAREER_AGENT_ID;

export function isKnownAgentId(value: string | null | undefined): value is string {
  return typeof value === "string" && value in AGENTS;
}

/**
 * Display metadata for a graph id, falling back to the id itself.
 *
 * A deployment can register a graph this build has never heard of; showing its
 * id beats showing nothing.
 */
export function agentMeta(graphId: string | null | undefined): AgentMeta {
  if (isKnownAgentId(graphId)) return AGENTS[graphId];
  return {
    graphId: graphId ?? DEFAULT_AGENT_ID,
    name: graphId ?? "助手",
    description: "",
    color: "var(--brand-accent)",
    icon: Compass,
  };
}

/**
 * The specialists the Career Agent delegates to via the `task` tool.
 *
 * Informational, not selectable: they run inside a career-agent conversation,
 * never as a top-level agent.
 */
export const CAREER_SUBAGENTS = [
  { name: "简历优化", description: "根据职位描述改写简历", color: "#b07817" },
  { name: "面试教练", description: "按轮次准备 STAR 故事", color: "#2563eb" },
  { name: "公司调研", description: "实时调研公司与职位", color: "#d9785a" },
];
