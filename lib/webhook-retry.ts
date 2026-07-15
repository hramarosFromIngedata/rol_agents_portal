const INITIAL_DELAY_MS = 2_000;
const MAX_DELAY_MS = 60_000;
const BACKOFF_FACTOR = 2;
const MAX_ATTEMPTS = 8;

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// 4xx responses (other than 429, which just means "slow down") signal a
// permanent problem with the request itself (bad payload, auth, wrong URL) —
// retrying with the same body will never succeed, so give up immediately
// instead of burning through the retry budget.
function isPermanentFailure(status: number): boolean {
  return status >= 400 && status < 500 && status !== 429;
}

// POSTs a JSON body to `url`, retrying on failure (network error, 5xx, 429)
// with capped exponential backoff so a down webhook gets hit less and less
// often rather than spammed. Gives up after MAX_ATTEMPTS, or immediately on
// a permanent (non-retryable) client error. Runs to completion in the
// background — callers should not await this on the request/response path.
export async function postJsonWithRetry(url: string, body: unknown, label: string): Promise<void> {
  let delay = INITIAL_DELAY_MS;

  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    try {
      const res = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      if (res.ok) {
        if (attempt > 1) console.log(`[${label}] Envoi réussi après ${attempt} tentative(s).`);
        return;
      }
      if (isPermanentFailure(res.status)) {
        console.error(`[${label}] Abandon : erreur non récupérable (HTTP ${res.status}) à la tentative ${attempt}.`);
        return;
      }
      console.error(`[${label}] Tentative ${attempt}/${MAX_ATTEMPTS} échouée (HTTP ${res.status}).`);
    } catch (err) {
      console.error(`[${label}] Tentative ${attempt}/${MAX_ATTEMPTS} échouée (réseau) : ${err}.`);
    }

    if (attempt === MAX_ATTEMPTS) {
      console.error(`[${label}] Abandon après ${MAX_ATTEMPTS} tentatives.`);
      return;
    }

    console.error(`[${label}] Nouvelle tentative dans ${delay}ms.`);
    await sleep(delay);
    delay = Math.min(delay * BACKOFF_FACTOR, MAX_DELAY_MS);
  }
}
