import { useEffect, useRef, useState } from "react";

import { agentApi } from "@/lib/agent-api";
import { sampleDeck } from "@/lib/dashi-browser/sample-deck.js";
import {
  buildNativeDashiEditorDocument,
  nativeStateToBrowserDeck,
  SAVE_MESSAGE,
} from "@/lib/dashi-browser/native-editor-document.js";

export function ClassroomPresentationPage({ presentationId }) {
  const [srcDoc, setSrcDoc] = useState("");
  const [error, setError] = useState("");
  const persistence = useRef(null);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const templatePromise = fetch("/dashi/assets/template-swiss.html")
          .then(requireOk)
          .then((response) => response.text());
        let deck = sampleDeck;
        let expectedChecksum = "";
        if (presentationId !== "browser-demo") {
          const [aggregate, storedDeck] = await Promise.all([
            agentApi.getClassroomPresentation(presentationId),
            agentApi.getClassroomPresentationDeck(presentationId),
          ]);
          deck = storedDeck;
          expectedChecksum = aggregate.presentation.checksum;
        }
        const [template, runtimeCatalog] = await Promise.all([
          templatePromise,
          fetch(`/dashi/runtime/${encodeURIComponent(deck.theme)}.json`)
            .then(requireOk)
            .then((response) => response.json()),
        ]);
        if (cancelled) return;
        persistence.current = { deck, expectedChecksum, chain: Promise.resolve() };
        setSrcDoc(buildNativeDashiEditorDocument({ template, runtimeCatalog, deck }));
      } catch (cause) {
        if (!cancelled) setError(cause instanceof Error ? cause.message : "presentation_open_failed");
      }
    })();
    return () => { cancelled = true; persistence.current = null; };
  }, [presentationId]);

  useEffect(() => {
    const receive = (event) => {
      if (event.origin !== window.location.origin || event.data?.type !== SAVE_MESSAGE) return;
      const current = persistence.current;
      if (!current) return;
      if (presentationId === "browser-demo") {
        event.source?.postMessage({ type: `${SAVE_MESSAGE}:result`, requestId: event.data.requestId, ok: true }, event.origin);
        return;
      }
      const nextDeck = nativeStateToBrowserDeck(current.deck, event.data.state);
      current.deck = nextDeck;
      const source = event.source;
      const requestId = event.data.requestId;
      current.chain = current.chain.then(async () => {
        try {
          const saved = await agentApi.saveClassroomPresentationDeck(presentationId, {
            expectedChecksum: current.expectedChecksum,
            deck: nextDeck,
          });
          current.expectedChecksum = saved.checksum;
          source?.postMessage({ type: `${SAVE_MESSAGE}:result`, requestId, ok: true }, event.origin);
        } catch (saveError) {
          source?.postMessage({
            type: `${SAVE_MESSAGE}:result`,
            requestId,
            ok: false,
            status: saveError instanceof Error && saveError.message === "presentation_edit_conflict" ? 409 : 500,
            error: saveError instanceof Error ? saveError.message : "save_failed",
          }, event.origin);
        }
      });
    };
    window.addEventListener("message", receive);
    return () => window.removeEventListener("message", receive);
  }, [presentationId]);

  if (error) return <main className="grid h-dvh place-items-center bg-canvas px-6 text-sm text-red">课堂演示暂时无法打开，请稍后重试。</main>;
  if (!srcDoc) return <main className="grid h-dvh place-items-center bg-canvas text-sm text-ink-3">正在打开 Dashi 演示控制台…</main>;
  return (
    <iframe
      className="block h-dvh w-full border-0"
      title="Dashi 演示控制台"
      sandbox="allow-scripts allow-same-origin allow-forms allow-downloads allow-modals allow-popups"
      srcDoc={srcDoc}
    />
  );
}

function requireOk(response) {
  if (!response.ok) throw new Error(`request_failed:${response.status}`);
  return response;
}
