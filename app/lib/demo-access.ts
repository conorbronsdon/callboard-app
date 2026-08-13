/**
 * Pure policy for the one-click demo authentication boundary.
 *
 * Demo auth needs an explicit disposable profile, a second opt-in, and a valid
 * future deadline. Missing or malformed deadlines fail closed.
 */
export function demoAccessEnabled(input: {
  deploymentProfile: string | undefined;
  demoMode: string | undefined;
  expiresAt: string | undefined;
  now?: number;
}): boolean {
  const profile = input.deploymentProfile?.trim().toLowerCase();
  const flag = input.demoMode?.trim().toLowerCase();
  const expiry = Date.parse(input.expiresAt ?? "");
  const now = input.now ?? Date.now();
  return (
    profile === "demo" &&
    (flag === "1" || flag === "true") &&
    Number.isFinite(expiry) &&
    expiry > now
  );
}

/** Production is never affected; a demo-profile Worker closes entirely at its deadline. */
export function demoDeploymentExpired(input: {
  deploymentProfile: string | undefined;
  expiresAt: string | undefined;
  now?: number;
}): boolean {
  if (input.deploymentProfile?.trim().toLowerCase() !== "demo") return false;
  const expiry = Date.parse(input.expiresAt ?? "");
  return !Number.isFinite(expiry) || expiry <= (input.now ?? Date.now());
}
