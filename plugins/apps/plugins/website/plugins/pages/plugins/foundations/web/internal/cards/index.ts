import type { AnyCardDef } from "../kit/types";
import { backgroundCard } from "./background";
import { blocksCard } from "./blocks";
import { centralCard } from "./central";
import { cliCard } from "./cli";
import { composeCard } from "./compose";
import { crossappCard } from "./crossapp";
import { dataviewCard } from "./dataview";
import { durableCard } from "./durable";
import { envsCard } from "./envs";
import { forksCard } from "./forks";
import { gatewayCard } from "./gateway";
import { guardsCard } from "./guards";
import { hotswapCard } from "./hotswap";
import { isolationCard } from "./isolation";
import { layoutCard } from "./layout";
import { liveCard } from "./live";
import { loopCard } from "./loop";
import { mentionsCard } from "./mentions";
import { migrationsCard } from "./migrations";
import { optimisticCard } from "./optimistic";
import { pageserverCard } from "./pageserver";
import { pluginCard } from "./plugin";
import { plugtreeCard } from "./plugtree";
import { profilingCard } from "./profiling";
import { protectedCard } from "./protected";
import { richtextCard } from "./richtext";
import { sessionsCard } from "./sessions";
import { slotsCard } from "./slots";
import { statusCard } from "./status";
import { tabsCard } from "./tabs";
import { themesCard } from "./themes";
import { triggersCard } from "./triggers";
import { windowCard } from "./window";

/**
 * Every card of the iceberg, by key: a closed, authored list (one file per
 * card), so it is plain data rather than a slot. A piece names its card by
 * this key (`IcebergPiece.card`), and `CardKey` is derived from it — a piece
 * naming a card that does not exist does not type.
 */
export const CARDS = {
  background: backgroundCard,
  blocks: blocksCard,
  central: centralCard,
  cli: cliCard,
  compose: composeCard,
  crossapp: crossappCard,
  dataview: dataviewCard,
  durable: durableCard,
  envs: envsCard,
  forks: forksCard,
  gateway: gatewayCard,
  guards: guardsCard,
  hotswap: hotswapCard,
  isolation: isolationCard,
  layout: layoutCard,
  live: liveCard,
  loop: loopCard,
  mentions: mentionsCard,
  migrations: migrationsCard,
  optimistic: optimisticCard,
  pageserver: pageserverCard,
  plugin: pluginCard,
  plugtree: plugtreeCard,
  profiling: profilingCard,
  protected: protectedCard,
  richtext: richtextCard,
  sessions: sessionsCard,
  slots: slotsCard,
  status: statusCard,
  tabs: tabsCard,
  themes: themesCard,
  triggers: triggersCard,
  window: windowCard,
} satisfies Record<string, AnyCardDef>;

export type CardKey = keyof typeof CARDS;
