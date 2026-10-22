import { getPlacesClient } from "@plugins/integrations/plugins/google-maps/server";
import {
  PHOTO_NAME_PATTERN,
  PlacesApiError,
} from "@plugins/integrations/plugins/google-maps/plugins/places-api/core";
import { placePhoto } from "@plugins/integrations/plugins/google-maps/plugins/places-api/server";
import { mapsBudgetNow } from "@plugins/integrations/plugins/google-maps/plugins/usage/server";
import { PHOTO_WIDTH } from "../../core";

/**
 * Stream one place photo from Google, same-origin. A raw handler (not
 * `implement`): it answers with the image's own bytes and type, cached
 * privately for a day — the browser then never asks twice for the same photo
 * at the same width. 404 when Google refuses the name (it expired: the card's
 * next details fetch brings fresh ones), 503 when no Places key is stored,
 * 429 once this month's Place Photo budget is spent (a card holding names
 * from before then must not bill past the free allowance).
 */
export async function handlePlacePhoto(req: Request): Promise<Response> {
  const q = new URL(req.url).searchParams;
  const name = q.get("name") ?? "";
  if (!PHOTO_NAME_PATTERN.test(name)) {
    return new Response("not a place photo name", { status: 400 });
  }
  const asked = Number(q.get("w") ?? 800);
  const width = Math.min(
    PHOTO_WIDTH.max,
    Math.max(PHOTO_WIDTH.min, Number.isFinite(asked) ? Math.round(asked) : 800),
  );
  const maps = await getPlacesClient();
  if (!maps.ok)
    return new Response("Google Maps is not set up", { status: 503 });
  if (!(await mapsBudgetNow()).withinBudget("place-photo")) {
    return new Response("this month's free Google photo quota is used", {
      status: 429,
    });
  }
  let image: Response;
  try {
    image = await placePhoto(maps.client, name, width);
  } catch (err) {
    if (
      err instanceof PlacesApiError &&
      err.status >= 400 &&
      err.status < 500
    ) {
      return new Response("photo no longer available", { status: 404 });
    }
    throw err;
  }
  return new Response(image.body, {
    headers: {
      "content-type": image.headers.get("content-type") ?? "image/jpeg",
      "cache-control": "private, max-age=86400",
    },
  });
}
