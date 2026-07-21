"use client";

import { useEffect, useRef, useState } from "react";
import ToastContainer, { ToastItem } from "./Toast";
import ConfirmDialog from "./ConfirmDialog";

const SUBMIT_URL = "/api/submit";
const URL_REGEX = /^(https?:\/\/)?([\da-z\.-]+)\.([a-z\.]{2,6})([\/\w \.-]*)*\/?$/i;

// Real n8n execution statuses: new/running/waiting are in-flight, success is
// terminal-ok, error/canceled/crashed are terminal-failure.
const RUNNING_STATUSES = ["new", "running", "waiting"];
const FAILURE_STATUSES = ["error", "canceled", "crashed"];
const FAILURE_MESSAGES: Record<string, string> = {
  error: "Le traitement a échoué.",
  canceled: "Le traitement a été annulé.",
  crashed: "Le traitement s'est interrompu de façon inattendue.",
};

type SendingState = "idle" | "sending";

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
  const [processId, setProcessId] = useState<string | null>(null);
  const [toasts, setToasts] = useState<ToastItem[]>([]);
  const [confirmStep, setConfirmStep] = useState<0 | 1 | 2>(0);

  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const toastIdRef = useRef(0);
  const timerStartRef = useRef<number | null>(null);

  const trimmedUrl = urlSource.trim();
  const hasFile = !!file;
  const hasUrlOrFile = trimmedUrl !== "" || hasFile;
  const urlPatternOk = trimmedUrl === "" || URL_REGEX.test(trimmedUrl);
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
  const submitDisabled = sendingState === "sending" ? false : !isFormValid;

  // Processing timer. The start reference lives in a ref (not state) so the
  // refresh button can rebase it without tearing down/restarting the interval.
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

  // Stop polling on unmount.
  useEffect(() => {
    return () => {
      if (pollRef.current) clearInterval(pollRef.current);
    };
  }, []);

  // Matricules are fetched fresh on every render of the page (mount) rather
  // than hardcoded, so the dropdown always reflects the current agent list.
  useEffect(() => {
    let cancelled = false;
    fetch("/api/agents")
      .then((res) => (res.ok ? res.json() : null))
      .then((json: { matricules?: unknown } | null) => {
        if (cancelled || !json) return;
        const list = Array.isArray(json.matricules)
          ? json.matricules.filter((m): m is number => typeof m === "number")
          : [];
        setAgentOptions(list);
      })
      .catch((err) => console.error("[n8n] Échec de la récupération de la liste des agents :", err));
    return () => {
      cancelled = true;
    };
  }, []);

  const { hours, minutes, seconds } = formatTime(elapsedMs);

  function showToast(message: string, type: "success" | "error" = "error", duration = 5000) {
    const id = ++toastIdRef.current;
    setToasts((t) => [...t, { id, message, type }]);
    setTimeout(() => dismissToast(id), duration);
  }

  function dismissToast(id: number) {
    setToasts((t) => t.filter((x) => x.id !== id));
  }

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

  function resetTimer() {
    timerStartRef.current = Date.now();
    setElapsedMs(0);
  }

  function startSending() {
    resetTimer();
    setSendingState("sending");
  }

  function stopSending() {
    // Stops the timer but deliberately leaves the elapsed value on screen
    // (success and error included) — it only resets via the refresh button
    // or the next "Traiter" launch.
    setSendingState("idle");
  }

  function stopPolling() {
    if (pollRef.current) {
      clearInterval(pollRef.current);
      pollRef.current = null;
    }
    setProcessId(null);
  }

  function startPolling(pid: string) {
    if (pollRef.current) return;
    pollRef.current = setInterval(async () => {
      try {
        const r = await fetch(`/api/executions/${encodeURIComponent(pid)}/status`);

        // 404 means the execution doesn't exist (bad id, deleted, ...) and
        // never will — retrying won't help, so abandon this task immediately
        // instead of polling forever every 3s.
        if (r.status === 404) {
          console.error(`[n8n] Exécution ${pid} introuvable (HTTP 404) : abandon du suivi.`);
          showToast("Exécution introuvable (404) : abandon du suivi.", "error");
          stopPolling();
          stopSending();
          return;
        }

        if (!r.ok) return;
        const j = await r.json();
        const st: string | null = j?.status ?? null;
        if (!st) return;

        // Still in flight: keep polling, keep "sending" state as-is.
        if (RUNNING_STATUSES.includes(st)) return;

        if (st === "success") {
          showToast("Traitement terminé avec succès.", "success");
          stopPolling();
          stopSending();
          fetch(`/api/executions/${encodeURIComponent(pid)}/report`).catch((err) => {
            console.error(`[n8n] Échec de la récupération du rapport pour l'exécution ${pid} :`, err);
          });
          return;
        }

        if (FAILURE_STATUSES.includes(st)) {
          const message = FAILURE_MESSAGES[st];
          console.error(`[n8n] Exécution ${pid} terminée avec le statut "${st}" : ${message}`);
          showToast(message, "error");
          stopPolling();
          stopSending();
          return;
        }

        // Unexpected status value: surface it explicitly rather than polling forever.
        console.error(`[n8n] Exécution ${pid} a retourné un statut inattendu : "${st}".`);
        showToast(`Statut inattendu reçu : ${st}`, "error");
        stopPolling();
        stopSending();
      } catch (err) {
        console.error("Erreur lors du polling du statut n8n :", err);
      }
    }, 3000);
  }

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (sendingState === "sending") return;
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
        showToast("Erreur serveur : " + res.status + " " + res.statusText, "error");
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
        showToast("Traitement en cours (process_id: " + (pid || "n/a") + ")", "success");
        if (pid) startPolling(pid);
        return;
      }

      stopSending();
      showToast("Données envoyées avec succès.", "success");
      resetForm();
    } catch {
      stopSending();
      showToast("Erreur réseau : impossible d'atteindre le serveur.", "error");
    }
  }

  function handleSubmitButtonClick(e: React.MouseEvent<HTMLButtonElement>) {
    if (sendingState !== "sending") return;
    e.preventDefault();
    setConfirmStep(1);
  }

  function performStop() {
    if (!processId) {
      showToast("Aucun process_id disponible pour arrêter le traitement.", "error");
      return;
    }

    const pid = processId;
    stopSending();
    fetch(`/api/executions/${encodeURIComponent(pid)}/stop`, { method: "POST" })
      .then((res) => {
        if (!res.ok) {
          console.error(`[n8n] Échec de la demande d'arrêt pour l'exécution ${pid} (HTTP ${res.status}).`);
          showToast("Impossible d'arrêter le traitement (serveur).", "error");
          return;
        }
        showToast("Traitement arrêté.", "success");
        stopPolling();
      })
      .catch((err) => {
        console.error("Erreur réseau lors de la demande d'arrêt du traitement :", err);
        showToast("Erreur réseau lors de la demande d'arrêt.", "error");
      });
  }

  const controlsDisabled = sendingState === "sending";

  return (
    <>
      <div className="mx-auto flex w-[90%] max-w-[1200px] flex-1 flex-wrap items-center gap-10 py-10">
        {/* Left column */}
        <div className="flex min-w-[300px] flex-1 flex-col justify-center">
          <div className="mb-6">
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img src="/logo.svg" alt="Ingedata Logo" className="w-[65%]" />
          </div>
          <hr className="h-0.5 w-1/2 rounded-full border-0 bg-white/20" />
          <h1 className="font-heading py-12 text-[2.5rem] leading-[1.1] font-bold md:text-[3.5rem]">
            ROL - Portail N8N
          </h1>

          <div className="mt-3 inline-flex items-center justify-start gap-4">
            <div className="flex min-w-[90px] flex-col items-center justify-center rounded-[20px] border border-white/20 bg-white/10 px-[18px] py-3.5 shadow-[0_10px_30px_rgba(0,0,0,0.15)] backdrop-blur-xl">
              <div className="flex h-12 items-center justify-center overflow-hidden">
                <span
                  key={hours}
                  className="font-heading animate-slide-up block text-[2rem] leading-none font-bold tracking-[-1px]"
                >
                  {hours}
                </span>
              </div>
              <span className="mt-2 text-[0.75rem] font-semibold tracking-[1.8px] text-white/70 uppercase">
                Heures
              </span>
            </div>
            <div className="font-heading pb-1.5 text-[2rem] font-bold text-white/70">:</div>
            <div className="flex min-w-[90px] flex-col items-center justify-center rounded-[20px] border border-white/20 bg-white/10 px-[18px] py-3.5 shadow-[0_10px_30px_rgba(0,0,0,0.15)] backdrop-blur-xl">
              <div className="flex h-12 items-center justify-center overflow-hidden">
                <span
                  key={minutes}
                  className="font-heading animate-slide-up block text-[2rem] leading-none font-bold tracking-[-1px]"
                >
                  {minutes}
                </span>
              </div>
              <span className="mt-2 text-[0.75rem] font-semibold tracking-[1.8px] text-white/70 uppercase">
                Minutes
              </span>
            </div>
            <div className="font-heading pb-1.5 text-[2rem] font-bold text-white/70">:</div>
            <div className="flex min-w-[90px] flex-col items-center justify-center rounded-[20px] border border-white/20 bg-white/10 px-[18px] py-3.5 shadow-[0_10px_30px_rgba(0,0,0,0.15)] backdrop-blur-xl">
              <div className="flex h-12 items-center justify-center overflow-hidden">
                <span
                  key={seconds}
                  className="font-heading animate-slide-up block text-[2rem] leading-none font-bold tracking-[-1px]"
                >
                  {seconds}
                </span>
              </div>
              <span className="mt-2 text-[0.75rem] font-semibold tracking-[1.8px] text-white/70 uppercase">
                Secondes
              </span>
            </div>

            <button
              type="button"
              onClick={resetTimer}
              title="Réinitialiser le chronomètre"
              aria-label="Réinitialiser le chronomètre"
              className="ml-2 flex h-10 w-10 flex-none items-center justify-center rounded-full border border-white/20 bg-white/10 text-white/70 transition-colors duration-300 hover:bg-white/15 hover:text-white"
            >
              <svg viewBox="0 0 24 24" className="h-5 w-5 fill-current">
                <path d="M12,2a10.032,10.032,0,0,1,7.122,3H16a1,1,0,0,0-1,1h0a1,1,0,0,0,1,1h4.143A1.858,1.858,0,0,0,22,5.143V1a1,1,0,0,0-1-1h0a1,1,0,0,0-1,1V3.078A11.981,11.981,0,0,0,.05,10.9a1.007,1.007,0,0,0,1,1.1h0a.982.982,0,0,0,.989-.878A10.014,10.014,0,0,1,12,2Z" />
                <path d="M22.951,12a.982.982,0,0,0-.989.878A9.986,9.986,0,0,1,4.878,19H8a1,1,0,0,0,1-1H9a1,1,0,0,0-1-1H3.857A1.856,1.856,0,0,0,2,18.857V23a1,1,0,0,0,1,1H3a1,1,0,0,0,1-1V20.922A11.981,11.981,0,0,0,23.95,13.1a1.007,1.007,0,0,0-1-1.1Z" />
              </svg>
            </button>
          </div>
        </div>

        {/* Right column */}
        <div className="flex min-w-[350px] flex-1 items-center justify-center">
          <div className="w-full max-w-[500px] rounded-3xl border border-white/20 bg-white/10 p-10 shadow-[0_20px_40px_rgba(0,0,0,0.2)] backdrop-blur-2xl">
            <h2 className="font-heading pb-6 text-2xl">Informations requises</h2>

            <form onSubmit={handleSubmit}>
              <div className="mb-5">
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
                    if (file && trimmed !== "" && URL_REGEX.test(trimmed)) {
                      setFile(null);
                      setFileFormatError(false);
                      if (fileInputRef.current) fileInputRef.current.value = "";
                    }
                  }}
                  className={fieldClass(urlInvalid, urlInputDisabled ? "opacity-60 pointer-events-none" : "")}
                />
              </div>

              <div className="mb-5">
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
                  <option value="francais">Français</option>
                  <option value="anglais">Anglais</option>
                  <option value="chinois">Chinois</option>
                  <option value="allemand">Allemand</option>
                  <option value="espagnol">Espagnol</option>
                  <option value="russe">Russe</option>
                </select>
              </div>

              <div className="mb-5">
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

              <div className="mb-5">
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

              <div className="mb-5">
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
                    "relative cursor-pointer rounded-xl border-2 border-dashed bg-black/10 px-5 py-7.5 text-center transition-all duration-300",
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
                <span className={sendingState === "sending" ? "opacity-90" : ""}>
                  {sendingState === "sending" ? "Annuler" : "Traiter"}
                </span>
              </button>
            </form>
          </div>
        </div>
      </div>

      <ToastContainer toasts={toasts} onDismiss={dismissToast} />

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
    </>
  );
}
