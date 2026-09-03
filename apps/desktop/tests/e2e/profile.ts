function positiveInteger(value: string | undefined, fallback: number): number {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
}

function positiveNumber(value: string | undefined): number | null {
  if (!value) return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : null;
}

function safeIdentifier(value: string): string {
  return value.replaceAll(/[^a-zA-Z0-9._-]/g, "-");
}

export const e2eProfile = {
  id: safeIdentifier(
    process.env.BX_SSH_E2E_MATRIX_ID ?? `${process.platform}-default`,
  ),
  viewportWidth: positiveInteger(process.env.BX_SSH_E2E_VIEWPORT_WIDTH, 1180),
  viewportHeight: positiveInteger(process.env.BX_SSH_E2E_VIEWPORT_HEIGHT, 760),
  expectedDeviceScaleFactor: positiveNumber(
    process.env.BX_SSH_E2E_EXPECTED_DEVICE_SCALE_FACTOR,
  ),
};
