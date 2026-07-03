import type { AgentProposedAction } from "@agent";
import { ChatComposer } from "./components/ChatComposer";
import { ChatMessageItem } from "./components/ChatMessageItem";
import type { ChatComposerDraft, ChatConversation, ChatSubmitOptions } from "./chatTypes";
import "./ChatConversationPage.css";

interface ChatConversationPageProps {
  conversation: ChatConversation;
  composerDraft: ChatComposerDraft;
  onApproveAgentAction?: (messageId: string, action: AgentProposedAction) => void;
  onCancelAgentAction?: (messageId: string, action: AgentProposedAction) => void;
  onComposerDraftChange: (draft: ChatComposerDraft) => void;
  onRejectAgentAction?: (messageId: string, action: AgentProposedAction) => void;
  onStopGenerating?: () => void;
  onSubmitMessage: (message: string, options: ChatSubmitOptions) => void;
  onMessageUiStateChange?: (messageId: string, uiState: ChatConversation["messages"][number]["uiState"]) => void;
}

export function ChatConversationPage({
  composerDraft,
  conversation,
  onApproveAgentAction,
  onCancelAgentAction,
  onComposerDraftChange,
  onRejectAgentAction,
  onStopGenerating,
  onSubmitMessage,
  onMessageUiStateChange,
}: ChatConversationPageProps) {
  const isGenerating = conversation.messages.some(
    (message) => message.role === "assistant" && message.status === "pending",
  );
  const lastAssistantMessageId = [...conversation.messages]
    .reverse()
    .find((message) => message.role === "assistant")?.id;

  return (
    <section className="chat-conversation-page" aria-label={conversation.title}>
      <div className="chat-conversation-page__messages">
        {conversation.messages.map((message) => (
          <ChatMessageItem
            isLastAssistantMessage={message.id === lastAssistantMessageId}
            key={message.id}
            message={message}
            onApprove={onApproveAgentAction}
            onCancel={onCancelAgentAction}
            onReject={onRejectAgentAction}
            onUiStateChange={onMessageUiStateChange}
          />
        ))}
      </div>

      <div className="chat-conversation-page__composer">
        <ChatComposer
          defaultProjectId={conversation.projectId}
          draft={composerDraft}
          isGenerating={isGenerating}
          onDraftChange={onComposerDraftChange}
          onStopGenerating={onStopGenerating}
          onSubmitMessage={onSubmitMessage}
        />
      </div>
    </section>
  );
}
