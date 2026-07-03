import { useEffect, useRef, useState } from "react";
import { ExternalLink } from "lucide-react";
import type { ChatWebSearchSource } from "../../chatTypes";
import { compareWebSearchSourcesByRelevance } from "../../agentWebSearch";
import { openExternalUrl } from "../../../../lib/externalLinks";

function getDomainInitial(domain: string) {
  return (domain.replace(/^www\./, "").match(/[a-z0-9]/i)?.[0] ?? "W").toUpperCase();
}

function openSourceUrl(url: string) {
  void openExternalUrl(url).catch((error) => {
    console.error("Failed to open external URL", error);
  });
}

export function SourceBadge({ source }: { source: ChatWebSearchSource }) {
  const [imageFailed, setImageFailed] = useState(false);

  if (source.faviconDataUrl && !imageFailed) {
    return (
      <span className="web-source-badge web-source-badge--image" aria-hidden="true">
        <img
          alt=""
          src={source.faviconDataUrl}
          onError={() => setImageFailed(true)}
        />
      </span>
    );
  }

  return (
    <span className="web-source-badge" aria-hidden="true">
      {getDomainInitial(source.domain)}
    </span>
  );
}

export function WebSearchSourcesList({
  mode = "compact",
  sources,
}: {
  mode?: "compact" | "rich";
  sources: ChatWebSearchSource[];
}) {
  if (sources.length === 0) {
    return <p className="web-search-activity__empty">没有返回可打开的网页来源。</p>;
  }

  const orderedSources = [...sources].sort(compareWebSearchSourcesByRelevance);

  return (
    <div className="web-search-sources-list">
      {orderedSources.map((source) => (
        <button
          className="web-search-source"
          key={source.id}
          onClick={() => openSourceUrl(source.url)}
          type="button"
        >
          <SourceBadge source={source} />
          <span className="web-search-source__content">
            <span className="web-search-source__url">{source.displayUrl}</span>
            {mode === "rich" && (
              <>
                <span className="web-search-source__title">{source.title}</span>
                {source.snippet && <span className="web-search-source__snippet">{source.snippet}</span>}
                {source.publishedDate && (
                  <span className="web-search-source__meta">
                    <span>{source.publishedDate}</span>
                  </span>
                )}
              </>
            )}
          </span>
          <ExternalLink aria-hidden="true" />
        </button>
      ))}
    </div>
  );
}

export function AssistantSources({ sources }: { sources: ChatWebSearchSource[] }) {
  const [isOpen, setOpen] = useState(false);
  const popoverRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!isOpen) return undefined;

    const handlePointerDown = (event: PointerEvent) => {
      const target = event.target;
      if (!(target instanceof Node)) return;
      if (popoverRef.current?.contains(target)) return;
      setOpen(false);
    };
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        setOpen(false);
      }
    };

    document.addEventListener("pointerdown", handlePointerDown);
    document.addEventListener("keydown", handleKeyDown);
    return () => {
      document.removeEventListener("pointerdown", handlePointerDown);
      document.removeEventListener("keydown", handleKeyDown);
    };
  }, [isOpen]);

  if (sources.length === 0) return null;

  return (
    <div className="assistant-sources" ref={popoverRef}>
      <button
        aria-expanded={isOpen}
        className="assistant-sources__button"
        onClick={() => setOpen((current) => !current)}
        type="button"
      >
        <span className="assistant-sources__badges" aria-hidden="true">
          {sources.slice(0, 3).map((source) => (
            <SourceBadge key={source.id} source={source} />
          ))}
        </span>
        <span>来源</span>
      </button>
      {isOpen && (
        <div className="assistant-sources__popover" role="dialog" aria-label="网页来源">
          <strong>来源</strong>
          <WebSearchSourcesList sources={sources} />
        </div>
      )}
    </div>
  );
}
