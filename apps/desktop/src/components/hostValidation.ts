const IPV4_PARTS = 4;
const MAX_IPV4_PART = 255;

export function isValidSshHost(value: string): boolean {
  const host = value.trim();
  if (!host || host !== value || host.length > 253) {
    return false;
  }

  if (isIpv4Address(host) || isIpv6Address(host)) {
    return true;
  }

  return isDomainName(host);
}

function isIpv4Address(host: string): boolean {
  const parts = host.split(".");
  return (
    parts.length === IPV4_PARTS &&
    parts.every(
      (part) => /^\d{1,3}$/.test(part) && Number(part) <= MAX_IPV4_PART,
    )
  );
}

function isIpv6Address(host: string): boolean {
  if (!host.includes(":") || host.includes("[") || host.includes("]")) {
    return false;
  }

  try {
    const parsed = new URL(`http://[${host}]/`);
    return parsed.hostname.startsWith("[") && parsed.hostname.endsWith("]");
  } catch {
    return false;
  }
}

function isDomainName(host: string): boolean {
  if (
    host.includes(":") ||
    host.includes("/") ||
    host.includes("\\") ||
    host.includes("@") ||
    /^[\d.]+$/.test(host)
  ) {
    return false;
  }

  const normalized = host.endsWith(".") ? host.slice(0, -1) : host;
  if (!normalized) {
    return false;
  }

  return normalized
    .split(".")
    .every(
      (label) =>
        label.length > 0 &&
        label.length <= 63 &&
        /^[a-zA-Z0-9](?:[a-zA-Z0-9-]*[a-zA-Z0-9])?$/.test(label),
    );
}
