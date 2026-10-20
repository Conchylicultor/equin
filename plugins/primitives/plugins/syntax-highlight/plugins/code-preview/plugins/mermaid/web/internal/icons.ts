import { symbol, type IconRef } from "@plugins/ui/plugins/icons/core";

/**
 * What a label names, read from its words: a Mermaid source carries no icons,
 * but a participant called `Backend` or a node called `Postgres` says what it
 * is. First match wins, so the specific words come before the general ones.
 */
const RULES: ReadonlyArray<{ re: RegExp; icon: IconRef }> = [
  {
    re: /\b(cli|terminal|shell|bash|zsh|tty|console)\b/,
    icon: symbol("terminal"),
  },
  {
    re: /\b(sdk|agent|process|worker|daemon|runtime|cpu|engine)\b/,
    icon: symbol("memory"),
  },
  {
    re: /\b(llm|model|claude|gpt|ai|bot|assistant)\b/,
    icon: symbol("auto-awesome"),
  },
  {
    re: /\b(db|database|postgres\w*|sql\w*|mysql|sqlite|pglite|redis|table)\b/,
    icon: symbol("database"),
  },
  {
    re: /\b(storage|disk|cache|bucket|s3|blob|store)\b/,
    icon: symbol("storage"),
  },
  {
    re: /\b(queue|inbox|relay|mailbox|pending\w*|buffer|topic)\b/,
    icon: symbol("inbox"),
  },
  { re: /\b(mail|email|gmail|smtp)\b/, icon: symbol("mail") },
  {
    re: /\b(chat|conversations?|messages?|transcript|slack)\b/,
    icon: symbol("chat"),
  },
  {
    re: /\b(web|browser|frontend|ui|client|page view|view|tab|spa)\b/,
    icon: symbol("web"),
  },
  { re: /\b(phone|mobile|ios|android)\b/, icon: symbol("smartphone") },
  {
    re: /\b(auth\w*|login|oauth|token|secrets?|keys?|credentials?)\b/,
    icon: symbol("key"),
  },
  {
    re: /\b(security|firewall|guard|permissions?|policy)\b/,
    icon: symbol("shield"),
  },
  {
    re: /\b(gateway|proxy|router|load balancer|network|socket|ws|websocket)\b/,
    icon: symbol("lan"),
  },
  { re: /\b(api|endpoint|rest|graphql|rpc|http)\b/, icon: symbol("api") },
  { re: /\b(server|backend|service|host|node)\b/, icon: symbol("dns") },
  {
    re: /\b(webhook|hook|events?|consumer|listener|notify)\b/,
    icon: symbol("webhook"),
  },
  { re: /\b(cloud|aws|gcp|azure|internet|remote)\b/, icon: symbol("cloud") },
  { re: /\b(markdown|md|fences?)\b|```/, icon: symbol("markdown") },
  { re: /\b(files?|folders?|dir\w*|viewer|fs)\b/, icon: symbol("folder") },
  {
    re: /\b(docs?|documents?|readme|report|article)\b/,
    icon: symbol("description"),
  },
  {
    re: /\b(pages?|blocks?|editor|canvas|layout)\b/,
    icon: symbol("view-quilt"),
  },
  {
    re: /\b(plugins?|extensions?|renderer|contribution|addon|module)\b/,
    icon: symbol("extension"),
  },
  { re: /\b(registry|hub|index|catalog|router)\b/, icon: symbol("hub") },
  {
    re: /\b(config\w*|settings?|options?|preferences?)\b/,
    icon: symbol("settings"),
  },
  { re: /\b(jobs?|cron|schedul\w*|timer|clock)\b/, icon: symbol("schedule") },
  { re: /\b(build|compile\w*|deploy\w*|ci|pipeline)\b/, icon: symbol("build") },
  { re: /\b(git|repo|code|source|branch|commit)\b/, icon: symbol("code") },
  { re: /\b(search|find|lookup|query)\b/, icon: symbol("search") },
  {
    re: /\b(users?|person|customer|human|admin|alice|bob)\b/,
    icon: symbol("person"),
  },
  { re: /\b(team|group|people|users)\b/, icon: symbol("group") },
  { re: /\b(start|begin|launch|run)\b/, icon: symbol("play-arrow") },
  { re: /\b(done|end|finish\w*|success|ok)\b/, icon: symbol("check-circle") },
  { re: /\b(errors?|fail\w*|crash\w*|reject\w*)\b/, icon: symbol("error") },
];

/**
 * The icon a label's words name, or `fallback` when none does. `texts` are
 * tried in order — a name before its subtitle, so `Web (conversation view)`
 * reads as the web, not as a chat.
 */
export function iconFor(
  texts: ReadonlyArray<string | null>,
  fallback: IconRef,
): IconRef {
  for (const text of texts) {
    if (!text) continue;
    const lower = text.toLowerCase();
    const hit = RULES.find((r) => r.re.test(lower));
    if (hit) return hit.icon;
  }
  return fallback;
}

export const participantIcon = symbol("deployed-code");
export const actorIcon = symbol("person");
export const nodeIcon = symbol("widgets");
