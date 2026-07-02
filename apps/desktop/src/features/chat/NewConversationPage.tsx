import { useFrontendConfig } from "../../config/FrontendConfigProvider";
import { ChatComposer } from "./components/ChatComposer";
import type { ChatComposerDraft, ChatSubmitOptions } from "./chatTypes";
import "./NewConversationPage.css";

interface NewConversationPageProps {
  draft: ChatComposerDraft;
  defaultProjectId?: string | null;
  onDraftChange: (draft: ChatComposerDraft) => void;
  onSubmitMessage: (message: string, options: ChatSubmitOptions) => void;
}

export function NewConversationPage({
  defaultProjectId = null,
  draft,
  onDraftChange,
  onSubmitMessage,
}: NewConversationPageProps) {
  const { t } = useFrontendConfig();

  return (
    <section className="new-conversation-page" aria-label={t("chat.newConversation")}>
      <div className="new-conversation-page__content">
        <h1>{t("chat.title")}</h1>
        <ChatComposer
          defaultProjectId={defaultProjectId}
          draft={draft}
          onDraftChange={onDraftChange}
          showProjectSelector
          onSubmitMessage={onSubmitMessage}
        />
      </div>
    </section>
  );
}
