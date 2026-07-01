import { ChatComposer } from "./components/ChatComposer";
import type { ChatConversation, ChatSubmitOptions } from "./chatTypes";
import "./ChatConversationPage.css";

interface ChatConversationPageProps {
  conversation: ChatConversation;
  onSubmitMessage: (message: string, options: ChatSubmitOptions) => void;
}

export function ChatConversationPage({ conversation, onSubmitMessage }: ChatConversationPageProps) {
  return (
    <section className="chat-conversation-page" aria-label={conversation.title}>
      <div className="chat-conversation-page__messages">
        {conversation.messages.map((message) => (
          <article
            className={`chat-message chat-message--${message.role}`}
            data-status={message.status}
            key={message.id}
          >
            <p>{message.content}</p>
          </article>
        ))}
      </div>

      <div className="chat-conversation-page__composer">
        <ChatComposer onSubmitMessage={onSubmitMessage} />
      </div>
    </section>
  );
}
