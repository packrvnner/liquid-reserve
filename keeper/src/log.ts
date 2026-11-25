import { request } from "node:https";

type Level = "INFO" | "WARN" | "ERROR" | "ALERT";
let webhook: string | undefined;
export function setAlertWebhook(url?: string) {
  webhook = url || undefined;
}

export function log(level: Level, msg: string) {
  const line = `${new Date().toISOString()} ${level.padEnd(5)} ${msg}`;
  (level === "INFO" ? console.log : console.error)(line);
  if (level === "ALERT" && webhook) postWebhook(msg);
}
export const info = (m: string) => log("INFO", m);
export const warn = (m: string) => log("WARN", m);
export const error = (m: string) => log("ERROR", m);
/** Needs a human. Also posted to ALERT_WEBHOOK_URL (Discord/Slack-style JSON) if set. */
export const alert = (m: string) => log("ALERT", m);

function postWebhook(msg: string) {
  try {
    const url = new URL(webhook!);
    const body = JSON.stringify({ content: `Liquid Reserve keeper: ${msg}`, text: `Liquid Reserve keeper: ${msg}` });
    const req = request(url, { method: "POST", headers: { "content-type": "application/json" } });
    req.on("error", () => {});
    req.end(body);
  } catch {
    /* never let alerting break the keeper */
  }
}
