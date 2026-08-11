"use client";

import { useEffect, useRef, useState } from "react";
import ConfirmDialog from "./ConfirmDialog";

// Next only auto-prefixes next/link, next/router and next/image with
// basePath — plain fetch() calls and <img> src attributes need it by hand.
const BASE_PATH = process.env.NEXT_PUBLIC_BASE_PATH ?? "";
const SUBMIT_URL = `${BASE_PATH}/api/submit`;

// Uses the URL constructor rather than a hand-rolled regex: a permissive
// path/host character class combined with a nested quantifier caused
// catastrophic backtracking (multi-second freeze) on URLs containing
// characters outside that class deep in the string (e.g. "%20" or a comma).
function isUrlLike(value: string): boolean {
  const candidate = /^https?:\/\//i.test(value) ? value : `https://${value}`;
  try {
    new URL(candidate);
    return true;
  } catch {
    return false;
  }
}

// Real n8n execution statuses: new/running/waiting are in-flight, success is
// terminal-ok, error/canceled/crashed are terminal-failure.
const RUNNING_STATUSES = ["new", "running", "waiting"];
const FAILURE_STATUSES = ["error", "canceled", "crashed"];
const FAILURE_MESSAGES: Record<string, string> = {
  error: "Le traitement a échoué.",
  canceled: "Le traitement a été annulé.",
  crashed: "Le traitement s'est interrompu de façon inattendue.",
};

// "manual" is the post-success review phase: n8n finished, and the operator
// is now reviewing/fixing the output by hand before validating.
type SendingState = "idle" | "sending" | "manual";

type Touched = {
  langue: boolean;
  code: boolean;
  categorie: boolean;
  url: boolean;
  file: boolean;
};

function formatTime(ms: number) {
  const totalSeconds = Math.floor(ms / 1000);
  const hours = Math.floor(totalSeconds / 3600)
    .toString()
    .padStart(2, "0");
  const minutes = Math.floor((totalSeconds % 3600) / 60)
    .toString()
    .padStart(2, "0");
  const seconds = (totalSeconds % 60).toString().padStart(2, "0");
  return { hours, minutes, seconds };
}

function fieldClass(invalid: boolean, extra = "") {
  return [
    "w-full rounded-xl border bg-white/10 px-4 py-3.5 text-base text-white outline-none transition-all duration-300 placeholder-white/40 focus:bg-white/15 focus:border-white",
    invalid ? "border-red-400 ring-[3px] ring-red-400/20 ring-inset" : "border-white/20",
    extra,
  ].join(" ");
}

export default function PortalForm() {
  const [urlSource, setUrlSource] = useState("");
  const [langue, setLangue] = useState("");
  const [code, setCode] = useState("");
  const [categorie, setCategorie] = useState("");
  const [file, setFile] = useState<File | null>(null);
  const [agentOptions, setAgentOptions] = useState<number[]>([]);
  const [langueOptions, setLangueOptions] = useState<string[]>([]);
  const [fileFormatError, setFileFormatError] = useState(false);
  const [isDragOver, setIsDragOver] = useState(false);
  const [touched, setTouched] = useState<Touched>({
    langue: false,
    code: false,
    categorie: false,
    url: false,
    file: false,
  });

  const [sendingState, setSendingState] = useState<SendingState>("idle");
  const [elapsedMs, setElapsedMs] = useState(0);
  // Manual review chrono, separate from elapsedMs (the n8n/auto chrono) —
  // starts the moment n8n succeeds, stops when the operator answers the
  // manual-correction prompt.
  const [manualElapsedMs, setManualElapsedMs] = useState(0);
  const [processId, setProcessId] = useState<string | null>(null);
  // Kept separate from processId, which gets cleared to null once
  // processing stops (stopPolling) so the stop button/beforeunload handler
  // know there's nothing left to cancel — this persists for display even
  // after the run has terminated.
  const [executionId, setExecutionId] = useState<string | null>(null);
  const [runStatus, setRunStatus] = useState<"processing" | "manual" | "error" | "finished" | null>(null);
  const [statusMessage, setStatusMessage] = useState<string | null>(null);
  const [confirmStep, setConfirmStep] = useState<0 | 1 | 2>(0);
  const [manualPromptOpen, setManualPromptOpen] = useState(false);

  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const timerStartRef = useRef<number | null>(null);
  const manualTimerStartRef = useRef<number | null>(null);

  const trimmedUrl = urlSource.trim();
  const hasFile = !!file;
  const hasUrlOrFile = trimmedUrl !== "" || hasFile;
  const urlPatternOk = trimmedUrl === "" || isUrlLike(trimmedUrl);
  const urlProvided = trimmedUrl !== "" && urlPatternOk;

  const urlOrFileTouched = touched.url || touched.file;
  const missingBoth = urlOrFileTouched && !hasUrlOrFile;

  const langueInvalid = touched.langue && !langue;
  const codeInvalid = touched.code && !code;
  const categorieInvalid = touched.categorie && !categorie;
  const urlInvalid = missingBoth || (touched.url && trimmedUrl !== "" && !urlPatternOk);
  const dropZoneInvalid = missingBoth || fileFormatError;

  const isFormValid =
    langue !== "" &&
    code !== "" &&
    categorie !== "" &&
    hasUrlOrFile &&
    urlPatternOk &&
    !fileFormatError;

  const fileInputDisabled = urlProvided;
  const urlInputDisabled = hasFile;
  // Enabled whenever there's a non-idle phase to act on (stop the auto run,
  // or validate the manual review) — the button's meaning switches with
  // sendingState rather than always re-submitting the form.
  const submitDisabled = sendingState === "idle" ? !isFormValid : false;

  // Auto (n8n) processing timer. The start reference lives in a ref (not
  // state) so it can be rebased without tearing down/restarting the interval.
  useEffect(() => {
    if (sendingState !== "sending") return;
    timerStartRef.current = Date.now();
    const id = setInterval(() => {
      if (timerStartRef.current != null) {
        setElapsedMs(Date.now() - timerStartRef.current);
      }
    }, 1000);
    return () => clearInterval(id);
  }, [sendingState]);

  // Manual review timer, starts automatically once n8n succeeds (see
  // startManualPhase) and stops once the operator answers the
  // manual-correction prompt.
  useEffect(() => {
    if (sendingState !== "manual") return;
    manualTimerStartRef.current = Date.now();
    const id = setInterval(() => {
      if (manualTimerStartRef.current != null) {
        setManualElapsedMs(Date.now() - manualTimerStartRef.current);
      }
    }, 1000);
    return () => clearInterval(id);
  }, [sendingState]);

  // Stop polling on unmount.
  useEffect(() => {
    return () => {
      if (pollRef.current) clearInterval(pollRef.current);
    };
  }, []);

  // Warn before leaving/reloading while a treatment is in flight — either
  // n8n is still running, or the operator hasn't answered the
  // manual-correction prompt yet — and if the user actually leaves during
  // the n8n phase, cancel it server-side rather than letting it run
  // unattended. unload only fires once beforeunload's prompt is accepted (or
  // isn't shown), so a cancelled reload never triggers the stop call.
  // sendBeacon (not fetch) is used because regular requests can get aborted
  // mid-flight once the page starts tearing down.
  useEffect(() => {
    function handleBeforeUnload(e: BeforeUnloadEvent) {
      if (sendingState === "idle") return;
      e.preventDefault();
      e.returnValue = "";
    }

    function handleUnload() {
      if (sendingState !== "sending" || !processId) return;
      navigator.sendBeacon(`${BASE_PATH}/api/executions/${encodeURIComponent(processId)}/stop`);
    }

    window.addEventListener("beforeunload", handleBeforeUnload);
    window.addEventListener("unload", handleUnload);
    return () => {
      window.removeEventListener("beforeunload", handleBeforeUnload);
      window.removeEventListener("unload", handleUnload);
    };
  }, [sendingState, processId]);

  // Matricules and langues are fetched fresh on every render of the page
  // (mount) rather than hardcoded, so both dropdowns always reflect the
  // current form data.
  useEffect(() => {
    let cancelled = false;
    fetch(`${BASE_PATH}/api/form-data`)
      .then((res) => (res.ok ? res.json() : null))
      .then((json: { matricules?: unknown; langues?: unknown } | null) => {
        if (cancelled || !json) return;
        const matricules = Array.isArray(json.matricules)
          ? json.matricules.filter((m): m is number => typeof m === "number")
          : [];
        const langues = Array.isArray(json.langues)
          ? json.langues.filter((l): l is string => typeof l === "string")
          : [];
        setAgentOptions(matricules);
        setLangueOptions(langues);
      })
      .catch((err) => console.error("[n8n] Échec de la récupération des données du formulaire :", err));
    return () => {
      cancelled = true;
    };
  }, []);

  const { hours, minutes, seconds } = formatTime(elapsedMs);
  const manualTime = formatTime(manualElapsedMs);

  function markTouched(key: keyof Touched) {
    setTouched((t) => (t[key] ? t : { ...t, [key]: true }));
  }

  function handleIncomingFile(f: File) {
    markTouched("file");
    if (!f.name.toLowerCase().endsWith(".pdf")) {
      setFileFormatError(true);
      setFile(null);
      if (fileInputRef.current) fileInputRef.current.value = "";
      return;
    }
    setFileFormatError(false);
    setFile(f);
  }

  function handleFileInputChange(e: React.ChangeEvent<HTMLInputElement>) {
    const f = e.target.files?.[0];
    if (f) {
      handleIncomingFile(f);
    } else {
      markTouched("file");
      setFile(null);
      setFileFormatError(false);
    }
  }

  function handleClearFile() {
    setFile(null);
    setFileFormatError(false);
    if (fileInputRef.current) fileInputRef.current.value = "";
  }

  // Only the url/file inputs reset after a successful processing — langue,
  // code et categorie restent pré-remplis pour le prochain envoi.
  function resetUrlAndFile() {
    setUrlSource("");
    handleClearFile();
    setTouched((t) => ({ ...t, url: false, file: false }));
  }

  function preventDefaults(e: React.DragEvent) {
    e.preventDefault();
    e.stopPropagation();
  }

  function handleDrop(e: React.DragEvent) {
    preventDefaults(e);
    setIsDragOver(false);
    const f = e.dataTransfer?.files?.[0];
    if (f) handleIncomingFile(f);
  }

  function resetForm() {
    setUrlSource("");
    setLangue("");
    setCode("");
    setCategorie("");
    setFile(null);
    setFileFormatError(false);
    if (fileInputRef.current) fileInputRef.current.value = "";
    setTouched({ langue: false, code: false, categorie: false, url: false, file: false });
  }

  function startSending() {
    timerStartRef.current = Date.now();
    setElapsedMs(0);
    // Manual chrono too — otherwise a new "Traiter" click still shows the
    // previous run's manual review duration until (if ever) a new manual
    // phase actually starts.
    manualTimerStartRef.current = null;
    setManualElapsedMs(0);
    setExecutionId(null);
    setRunStatus("processing");
    setStatusMessage(null);
    setSendingState("sending");
  }

  function stopSending() {
    // Stops the timer but deliberately leaves the elapsed value on screen
    // (success and error included) — it only resets on the next "Traiter"
    // launch.
    setSendingState("idle");
  }

  // Entered automatically once n8n succeeds (see the "success" branch in
  // startPolling) — starts the second, manual-review chrono and swaps the
  // submit button into "Valider le traitement manuel" until the operator
  // answers the manual-correction prompt.
  function startManualPhase() {
    manualTimerStartRef.current = Date.now();
    setManualElapsedMs(0);
    setRunStatus("manual");
    setSendingState("manual");
  }

  // Called once the operator answers "avez-vous eu besoin de corriger
  // manuellement ?". Stops the manual chrono, returns the button to
  // "Traiter", and sends the manual timing/answer to the report route —
  // the only place this data can come from, since n8n has no notion of it.
  function finalizeManualPhase(manuallyCorrected: boolean) {
    setManualPromptOpen(false);
    // Read from the ref (exact instant startManualPhase actually started)
    // and take "now" as the stop instant, rather than the displayed
    // manualElapsedMs — that value is only refreshed once a second by the
    // display interval, so it can lag the real answer instant by up to 1s.
    const manualStartedAt =
      manualTimerStartRef.current != null ? new Date(manualTimerStartRef.current).toISOString() : null;
    const manualStoppedAt = new Date().toISOString();
    setRunStatus("finished");
    setStatusMessage(
      manuallyCorrected
        ? "Traitement manuel terminé (correction effectuée)."
        : "Traitement manuel terminé (aucune correction nécessaire)."
    );
    setSendingState("idle");

    const eid = executionId;
    if (!eid || !manualStartedAt) return;
    fetch(`${BASE_PATH}/api/executions/${encodeURIComponent(eid)}/report`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ manualStartedAt, manualStoppedAt, manuallyCorrected }),
    }).catch((err) => {
      console.error(`[n8n] Échec de l'envoi des données de correction manuelle pour l'exécution ${eid} :`, err);
    });
  }

  function stopPolling() {
    if (pollRef.current) {
      clearInterval(pollRef.current);
      pollRef.current = null;
    }
    setProcessId(null);
  }

  // Triggers report construction + storage to the sheet (GET, see
  // app/api/executions/[id]/report/route.ts) — used for FAILED runs only.
  // A successful run's report/storage happens exactly once, later, via the
  // POST call in finalizeManualPhase (once manual-review data is known) —
  // calling this here too would store that execution twice, once
  // prematurely with manual fields still null. Returns the report (or null
  // on failure) so callers that need status_message can await it; callers
  // that only care about the storage side effect can call it
  // fire-and-forget.
  async function fetchReport(pid: string): Promise<{ status_message?: string } | null> {
    try {
      const res = await fetch(`${BASE_PATH}/api/executions/${encodeURIComponent(pid)}/report`);
      if (!res.ok) return null;
      return await res.json();
    } catch (err) {
      console.error(`[n8n] Échec de la récupération du rapport pour l'exécution ${pid} :`, err);
      return null;
    }
  }

  function startPolling(pid: string) {
    if (pollRef.current) return;
    pollRef.current = setInterval(async () => {
      try {
        const r = await fetch(`${BASE_PATH}/api/executions/${encodeURIComponent(pid)}/status`);

        // 404 means the execution doesn't exist (bad id, deleted, ...) and
        // never will — retrying won't help, so abandon this task immediately
        // instead of polling forever every 3s.
        if (r.status === 404) {
          const message = "Exécution introuvable (404) : abandon du suivi.";
          console.error(`[n8n] ${message}`);
          stopPolling();
          stopSending();
          setRunStatus("error");
          setStatusMessage(message);
          return;
        }

        if (!r.ok) return;
        const j = await r.json();
        const st: string | null = j?.status ?? null;
        if (!st) return;

        // Still in flight: keep polling, keep "sending" state as-is.
        if (RUNNING_STATUSES.includes(st)) return;

        if (st === "success") {
          stopPolling();
          setStatusMessage("executed successfully");
          resetUrlAndFile();
          // No fetchReport(pid) here on purpose: the report for a
          // successful run is only ever fetched/stored once, later, from
          // finalizeManualPhase's POST — see the comment on fetchReport.
          startManualPhase();
          return;
        }

        if (FAILURE_STATUSES.includes(st)) {
          stopPolling();
          stopSending();
          setRunStatus("error");

          // Only "error" gets a dynamic message (the real n8n failure
          // reason, via status_message — same method as the sheet report:
          // resultData.error.message from includeData=true). canceled/
          // crashed keep their static messages since they aren't node
          // failures with a meaningful error text to surface.
          if (st === "error") {
            const report = await fetchReport(pid);
            const message =
              typeof report?.status_message === "string" ? report.status_message : FAILURE_MESSAGES.error;
            console.error(`[n8n] Exécution ${pid} terminée avec le statut "error" : ${message}`);
            setStatusMessage(message);
          } else {
            const message = FAILURE_MESSAGES[st];
            console.error(`[n8n] Exécution ${pid} terminée avec le statut "${st}" : ${message}`);
            setStatusMessage(message);
            fetchReport(pid);
          }
          return;
        }

        // Unexpected status value: surface it explicitly rather than polling forever.
        const message = `Statut inattendu reçu : ${st}`;
        console.error(`[n8n] Exécution ${pid} a retourné un statut inattendu : "${st}".`);
        stopPolling();
        stopSending();
        setRunStatus("error");
        setStatusMessage(message);
      } catch (err) {
        console.error("Erreur lors du polling du statut n8n :", err);
      }
    }, 3000);
  }

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    // Covers both "sending" and "manual" — neither should ever re-submit
    // the form. Pressing Enter in a text field bypasses the button's own
    // onClick guard (handleSubmitButtonClick) and calls this directly, so
    // the guard has to live here too.
    if (sendingState !== "idle") return;
    if (!isFormValid) return;

    const data = new FormData();
    data.append("url-source", trimmedUrl);
    data.append("langue", langue);
    data.append("code", code);
    data.append("categorie", categorie);
    data.append("document_pdf", file ?? "");

    startSending();

    try {
      const res = await fetch(SUBMIT_URL, { method: "POST", body: data });

      if (!res.ok) {
        stopSending();
        setRunStatus("error");
        setStatusMessage("Erreur serveur : " + res.status + " " + res.statusText);
        return;
      }

      let json: unknown = null;
      try {
        json = await res.json();
      } catch {
        json = null;
      }

      // n8n may respond with the processing payload either bare
      // ({code, status, process_id}) or wrapped in an array.
      const payload =
        Array.isArray(json) && json.length > 0
          ? (json[0] as Record<string, unknown>)
          : (json as Record<string, unknown> | null);

      if (payload && payload.code === 202 && payload.status === "processing") {
        const pid: string | null = (payload.process_id as string) || null;
        setProcessId(pid);
        setExecutionId(pid);
        if (pid) startPolling(pid);
        return;
      }

      stopSending();
      setRunStatus("finished");
      setStatusMessage("Données envoyées avec succès.");
      resetForm();
    } catch {
      stopSending();
      setRunStatus("error");
      setStatusMessage("Erreur réseau : impossible d'atteindre le serveur.");
    }
  }

  function handleSubmitButtonClick(e: React.MouseEvent<HTMLButtonElement>) {
    if (sendingState === "sending") {
      e.preventDefault();
      setConfirmStep(1);
      return;
    }
    if (sendingState === "manual") {
      e.preventDefault();
      setManualPromptOpen(true);
      return;
    }
  }

  function performStop() {
    if (!processId) {
      console.error("Aucun process_id disponible pour arrêter le traitement.");
      return;
    }

    const pid = processId;
    stopSending();
    setRunStatus("error");
    setStatusMessage("Traitement arrêté.");
    fetch(`${BASE_PATH}/api/executions/${encodeURIComponent(pid)}/stop`, { method: "POST" })
      .then((res) => {
        if (!res.ok) {
          const message = `Impossible d'arrêter le traitement (serveur, HTTP ${res.status}).`;
          console.error(`[n8n] Échec de la demande d'arrêt pour l'exécution ${pid} (HTTP ${res.status}).`);
          setStatusMessage(message);
          return;
        }
        stopPolling();
      })
      .catch((err) => {
        console.error("Erreur réseau lors de la demande d'arrêt du traitement :", err);
        setStatusMessage("Erreur réseau lors de la demande d'arrêt.");
      });
  }

  // Form stays frozen through both the auto run and the manual review — url
  // and file were already cleared by resetUrlAndFile on success, so there's
  // nothing to edit until the operator validates the manual review anyway.
  const controlsDisabled = sendingState !== "idle";

  return (
    <>
      <div className="mx-auto flex w-[90%] max-w-[1200px] min-h-0 flex-1 flex-wrap items-center gap-10 py-[clamp(1rem,4vh,2.5rem)]">
        {/* Left column */}
        <div className="flex min-w-[300px] flex-1 flex-col justify-center">
          <div className="mb-[clamp(0.75rem,2.4vh,1.5rem)]">
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img src={`${BASE_PATH}/logo.svg`} alt="Ingedata Logo" className="w-[65%]" />
          </div>
          <hr className="h-0.5 w-1/2 rounded-full border-0 bg-white/20" />
          <h1 className="font-heading py-[clamp(1.25rem,4.8vh,3rem)] text-[clamp(1.75rem,4vh,2.5rem)] leading-[1.1] font-bold md:text-[clamp(2rem,5.6vh,3.5rem)]">
            ROL - Portail N8N
          </h1>

          <div className="mt-3 space-y-1 rounded-2xl border border-white/20 bg-white/10 px-5 py-4 shadow-[0_10px_30px_rgba(0,0,0,0.15)] backdrop-blur-xl">
            <p className="text-sm"><u><strong>id d&apos;exécution:</strong></u> {executionId ?? "—"}</p>
            <p className="text-sm">
              <u><strong>Temps de traitement N8N:</strong></u> {hours} heures : {minutes} minutes : {seconds}{" "}
              secondes
            </p>
            <p className="text-sm">
              <u><strong>Temps de traitement Manuel:</strong></u> {manualTime.hours} heures : {manualTime.minutes}{" "}
              minutes : {manualTime.seconds} secondes
            </p>
            <p className="text-sm"><u><strong>status:</strong></u> {runStatus ?? "—"}</p>
            <p className="text-sm"><u><strong>status_message:</strong></u> {statusMessage ?? "—"}</p>
          </div>
        </div>

        {/* Right column */}
        <div className="flex min-w-[350px] flex-1 items-center justify-center">
          <div className="w-full max-w-[500px] rounded-3xl border border-white/20 bg-white/10 p-[clamp(1rem,4vh,2.5rem)] shadow-[0_20px_40px_rgba(0,0,0,0.2)] backdrop-blur-2xl">
            <h2 className="font-heading pb-[clamp(0.75rem,2.4vh,1.5rem)] text-2xl">Informations requises</h2>

            <form onSubmit={handleSubmit}>
              <div className="mb-[clamp(0.625rem,2vh,1.25rem)]">
                <label htmlFor="url-source" className="mb-2 block text-sm font-semibold">
                  Lien URL
                </label>
                <input
                  type="url"
                  id="url-source"
                  name="url-source"
                  placeholder="https://..."
                  value={urlSource}
                  disabled={urlInputDisabled || controlsDisabled}
                  onChange={(e) => {
                    const value = e.target.value;
                    setUrlSource(value);
                    markTouched("url");
                    const trimmed = value.trim();
                    if (file && trimmed !== "" && isUrlLike(trimmed)) {
                      setFile(null);
                      setFileFormatError(false);
                      if (fileInputRef.current) fileInputRef.current.value = "";
                    }
                  }}
                  className={fieldClass(urlInvalid, urlInputDisabled ? "opacity-60 pointer-events-none" : "")}
                />
              </div>

              <div className="mb-[clamp(0.625rem,2vh,1.25rem)]">
                <label htmlFor="langue" className="mb-2 block text-sm font-semibold">
                  Langue
                </label>
                <select
                  id="langue"
                  name="langue"
                  required
                  value={langue}
                  disabled={controlsDisabled}
                  onChange={(e) => {
                    setLangue(e.target.value);
                    markTouched("langue");
                  }}
                  className={fieldClass(langueInvalid, "appearance-none cursor-pointer")}
                >
                  <option value="" disabled>
                    Sélectionnez une langue...
                  </option>
                  {langueOptions.map((langueOption) => (
                    <option key={langueOption} value={langueOption}>
                      {langueOption}
                    </option>
                  ))}
                </select>
              </div>

              <div className="mb-[clamp(0.625rem,2vh,1.25rem)]">
                <label htmlFor="code" className="mb-2 block text-sm font-semibold">
                  Matricule
                </label>
                <select
                  id="code"
                  name="code"
                  required
                  value={code}
                  disabled={controlsDisabled}
                  onChange={(e) => {
                    setCode(e.target.value);
                    markTouched("code");
                  }}
                  className={fieldClass(codeInvalid, "appearance-none cursor-pointer")}
                >
                  <option value="" disabled>
                    Sélectionnez votre matricule...
                  </option>
                  {agentOptions.map((matricule) => (
                    <option key={matricule} value={matricule}>
                      {matricule}
                    </option>
                  ))}
                </select>
              </div>

              <div className="mb-[clamp(0.625rem,2vh,1.25rem)]">
                <label className="mb-2 block text-sm font-semibold">Catégorie</label>
                <div
                  className={[
                    "flex gap-6 rounded-lg py-2.5 transition-shadow",
                    categorieInvalid ? "ring-[3px] ring-red-400/20 ring-inset" : "",
                  ].join(" ")}
                >
                  <label className="flex cursor-pointer items-center text-base font-normal">
                    <input
                      type="radio"
                      name="categorie"
                      value="RG"
                      required
                      disabled={controlsDisabled}
                      checked={categorie === "RG"}
                      onChange={(e) => {
                        setCategorie(e.target.value);
                        markTouched("categorie");
                      }}
                      className="mr-2 h-[18px] w-[18px] cursor-pointer accent-white"
                    />
                    RG
                  </label>
                  <label className="flex cursor-pointer items-center text-base font-normal">
                    <input
                      type="radio"
                      name="categorie"
                      value="PS"
                      required
                      disabled={controlsDisabled}
                      checked={categorie === "PS"}
                      onChange={(e) => {
                        setCategorie(e.target.value);
                        markTouched("categorie");
                      }}
                      className="mr-2 h-[18px] w-[18px] cursor-pointer accent-white"
                    />
                    PS
                  </label>
                </div>
              </div>

              <div className="mb-[clamp(0.625rem,2vh,1.25rem)]">
                <label className="mb-2 block text-sm font-semibold">Document</label>
                <div
                  onDragEnter={(e) => {
                    preventDefaults(e);
                    setIsDragOver(true);
                  }}
                  onDragOver={(e) => {
                    preventDefaults(e);
                    setIsDragOver(true);
                  }}
                  onDragLeave={(e) => {
                    preventDefaults(e);
                    setIsDragOver(false);
                  }}
                  onDrop={handleDrop}
                  className={[
                    "relative cursor-pointer rounded-xl border-2 border-dashed bg-black/10 px-5 py-[clamp(1rem,3vh,1.875rem)] text-center transition-all duration-300",
                    isDragOver
                      ? "border-white bg-white/15"
                      : dropZoneInvalid
                        ? "border-red-400"
                        : "border-white/20",
                    fileInputDisabled ? "opacity-60 pointer-events-none" : "",
                  ].join(" ")}
                >
                  <svg
                    viewBox="0 0 24 24"
                    className={`mx-auto mb-3 h-8 w-8 fill-current ${isDragOver ? "text-white" : "text-white/70"}`}
                  >
                    <path d="M19.35 10.04C18.67 6.59 15.64 4 12 4 9.11 4 6.6 5.64 5.36 8.04 2.34 8.36 0 10.91 0 14c0 3.31 2.69 6 6 6h13c2.76 0 5-2.24 5-5 0-2.64-2.05-4.78-4.65-4.96zM14 13v4h-4v-4H7l5-5 5 5h-3z" />
                  </svg>
                  <p className={`mb-2 text-sm ${file ? "font-bold" : "font-normal"}`}>
                    {file ? `Fichier sélectionné : ${file.name}` : "Glissez-déposez le document ici ou cliquez"}
                  </p>
                  <span className="text-xs font-bold text-white/70">Format accepté : PDF uniquement</span>
                  <input
                    ref={fileInputRef}
                    type="file"
                    id="file-upload"
                    name="document_pdf"
                    accept=".pdf"
                    disabled={fileInputDisabled || controlsDisabled}
                    onChange={handleFileInputChange}
                    className="absolute inset-0 h-full w-full cursor-pointer opacity-0"
                  />
                  {file && (
                    <button
                      type="button"
                      aria-label="Retirer le fichier sélectionné"
                      disabled={controlsDisabled}
                      onClick={(e) => {
                        e.stopPropagation();
                        handleClearFile();
                      }}
                      className="absolute top-2 right-2 z-10 flex h-6 w-6 items-center justify-center rounded-full bg-black/40 text-white transition-colors duration-200 hover:bg-black/60 disabled:cursor-not-allowed disabled:opacity-40 disabled:hover:bg-black/40"
                    >
                      <svg viewBox="0 0 20 20" className="h-3 w-3 fill-current">
                        <path d="M10 8.586 4.707 3.293 3.293 4.707 8.586 10l-5.293 5.293 1.414 1.414L10 11.414l5.293 5.293 1.414-1.414L11.414 10l5.293-5.293-1.414-1.414z" />
                      </svg>
                    </button>
                  )}
                </div>
              </div>

              <button
                type="submit"
                onClick={handleSubmitButtonClick}
                disabled={submitDisabled}
                className="font-heading enabled:hover:-translate-y-0.5 enabled:hover:bg-neutral-100 mt-2.5 flex w-full items-center justify-center gap-2 rounded-xl bg-white px-4 py-4 text-base font-semibold text-[#002266] transition-all duration-300 disabled:cursor-not-allowed disabled:opacity-60"
              >
                {sendingState === "sending" && (
                  <span className="mr-2 inline-flex items-center" aria-hidden="true">
                    <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 200 200" className="block h-5 w-5">
                      <path
                        fill="#0044FF"
                        stroke="#0044FF"
                        strokeWidth={15}
                        style={{ transformOrigin: "center" }}
                        d="m148 84.7 13.8-8-10-17.3-13.8 8a50 50 0 0 0-27.4-15.9v-16h-20v16A50 50 0 0 0 63 67.4l-13.8-8-10 17.3 13.8 8a50 50 0 0 0 0 31.7l-13.8 8 10 17.3 13.8-8a50 50 0 0 0 27.5 15.9v16h20v-16a50 50 0 0 0 27.4-15.9l13.8 8 10-17.3-13.8-8a50 50 0 0 0 0-31.7Zm-47.5 50.8a35 35 0 1 1 0-70 35 35 0 0 1 0 70Z"
                      >
                        <animateTransform
                          type="rotate"
                          attributeName="transform"
                          calcMode="spline"
                          dur="2"
                          values="0;120"
                          keyTimes="0;1"
                          keySplines="0 0 1 1"
                          repeatCount="indefinite"
                        />
                      </path>
                    </svg>
                  </span>
                )}
                <span className={sendingState !== "idle" ? "opacity-90" : ""}>
                  {sendingState === "sending"
                    ? "Annuler"
                    : sendingState === "manual"
                      ? "Valider le traitement manuel"
                      : "Traiter"}
                </span>
              </button>
            </form>
          </div>
        </div>
      </div>

      <ConfirmDialog
        open={confirmStep === 1}
        title="Arrêter le traitement ?"
        message="Voulez-vous vraiment arrêter le traitement en cours ?"
        confirmLabel="Oui, continuer"
        cancelLabel="Non"
        onConfirm={() => setConfirmStep(2)}
        onCancel={() => setConfirmStep(0)}
      />
      <ConfirmDialog
        open={confirmStep === 2}
        title="Confirmation définitive"
        message="Cette action est irréversible : le traitement n8n sera arrêté définitivement. Confirmez-vous l'arrêt ?"
        confirmLabel="Arrêter définitivement"
        cancelLabel="Annuler"
        onConfirm={() => {
          setConfirmStep(0);
          performStop();
        }}
        onCancel={() => setConfirmStep(0)}
      />
      <ConfirmDialog
        open={manualPromptOpen}
        title="Correction manuelle"
        message="Avez-vous eu besoin de corriger manuellement ?"
        confirmLabel="Oui"
        cancelLabel="Non"
        onConfirm={() => finalizeManualPhase(true)}
        onCancel={() => finalizeManualPhase(false)}
      />
    </>
  );
}
