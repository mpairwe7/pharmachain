import { describe, expect, test } from "bun:test";
import type { ExecutionContext } from "@nestjs/common";
import { Reflector } from "@nestjs/core";
import { SUPER_ADMIN_KEY } from "../decorators";
import { PolicyGuard } from "./policy.guard";

/** Minimal ExecutionContext carrying just the request the guard inspects. */
function contextFor(user: unknown): ExecutionContext {
  const req = { user, headers: {} };
  return {
    getHandler: () => function handler() {},
    getClass: () => class Controller {},
    switchToHttp: () => ({ getRequest: () => req }),
  } as unknown as ExecutionContext;
}

/** A Reflector that reports the route as @SuperAdminOnly and nothing else. */
function superAdminOnlyReflector(): Reflector {
  return {
    getAllAndOverride: (key: string) => (key === SUPER_ADMIN_KEY ? true : undefined),
  } as unknown as Reflector;
}

describe("PolicyGuard super-admin gate (US-204)", () => {
  test("an authenticated non-super-admin gets 403, not 401", () => {
    // A 401 tells the web client the session died: providers.tsx redirects to
    // /login and the app layout signs the user out. Wrong role must not log a
    // valid session out.
    const guard = new PolicyGuard(superAdminOnlyReflector());
    let status: number | undefined;
    try {
      guard.canActivate(contextFor({ id: "u1", isSuperAdmin: false }));
    } catch (err) {
      status = (err as { getStatus?: () => number }).getStatus?.();
    }
    expect(status).toBe(403);
  });

  test("an unauthenticated caller still gets 401", () => {
    const guard = new PolicyGuard(superAdminOnlyReflector());
    let status: number | undefined;
    try {
      guard.canActivate(contextFor(undefined));
    } catch (err) {
      status = (err as { getStatus?: () => number }).getStatus?.();
    }
    expect(status).toBe(401);
  });

  test("a super admin passes", () => {
    const guard = new PolicyGuard(superAdminOnlyReflector());
    expect(guard.canActivate(contextFor({ id: "u1", isSuperAdmin: true }))).toBe(true);
  });
});
