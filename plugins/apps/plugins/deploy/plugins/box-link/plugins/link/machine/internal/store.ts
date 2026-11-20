import type { BoxLink } from "@plugins/apps/plugins/deploy/plugins/box-link/core";

// The links this instance holds, in memory: written by the link manager
// alone, read by the served values' loaders.
const links = new Map<string, BoxLink>();

export function currentLinks(): Record<string, BoxLink> {
  return Object.fromEntries(links);
}

export function linkOf(deploymentId: string): BoxLink | undefined {
  return links.get(deploymentId);
}

export function setLink(link: BoxLink): void {
  links.set(link.deploymentId, link);
}

export function dropLink(deploymentId: string): boolean {
  return links.delete(deploymentId);
}

export function linkedDeploymentIds(): string[] {
  return [...links.keys()];
}
