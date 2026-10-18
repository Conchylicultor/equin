import { defineFieldType, defineFieldIdentity } from "@plugins/fields/core";
import { symbol } from "@plugins/ui/plugins/icons/core";

const memoryIcon = symbol("memory");

// The value is the WIRE form, base64; the column stores the bytes
// (`StoredAs<Uint8Array>` on the field def, `bytesField`).
export const bytesFieldType = defineFieldType<string>("bytes");

export const bytesIdentity = defineFieldIdentity<string>({
  type: bytesFieldType,
  label: "Bytes",
  icon: memoryIcon,
});
