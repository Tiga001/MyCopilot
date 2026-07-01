import { useFrontendConfig } from "../../config/FrontendConfigProvider";
import { ChatComposer } from "./components/ChatComposer";
import type { ChatSubmitOptions } from "./chatTypes";
import "./NewConversationPage.css";

interface NewConversationPageProps {
  defaultProjectId?: string | null;
  onSubmitMessage: (message: string, options: ChatSubmitOptions) => void;
}

export function NewConversationPage({ defaultProjectId = null, onSubmitMessage }: NewConversationPageProps) {
  const { t } = useFrontendConfig();

  return (
    <section className="new-conversation-page" aria-label={t("chat.newConversation")}>
      <div className="new-conversation-page__content">
        <h1>{t("chat.title")}</h1>
        <ChatComposer defaultProjectId={defaultProjectId} showProjectSelector onSubmitMessage={onSubmitMessage} />
      </div>
    </section>
  );
}
