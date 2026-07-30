import { z } from "zod";
import { COMPANY_ROLES, COMPANY_TYPES } from "../enums";

// Misspellings of the mail domains our users actually type. A plain format
// check cannot catch these — `user@gmai.com` is perfectly well-formed — but
// none of them is a real mailbox, so accepting one means the verification mail
// silently bounces and the account is stranded.
const DOMAIN_TYPOS: Record<string, string> = {
  "gmai.com": "gmail.com",
  "gmial.com": "gmail.com",
  "gmil.com": "gmail.com",
  "gamil.com": "gmail.com",
  "gnail.com": "gmail.com",
  "gmaul.com": "gmail.com",
  "gmaill.com": "gmail.com",
  "ggmail.com": "gmail.com",
  "gmail.co": "gmail.com",
  "gmail.cm": "gmail.com",
  "gmail.con": "gmail.com",
  "gmail.om": "gmail.com",
  "yaho.com": "yahoo.com",
  "yahooo.com": "yahoo.com",
  "yhaoo.com": "yahoo.com",
  "yahoo.co": "yahoo.com",
  "yahoo.con": "yahoo.com",
  "hotmai.com": "hotmail.com",
  "hotmial.com": "hotmail.com",
  "hotmall.com": "hotmail.com",
  "hotnail.com": "hotmail.com",
  "hotmail.co": "hotmail.com",
  "hotmail.con": "hotmail.com",
  "outlok.com": "outlook.com",
  "outloook.com": "outlook.com",
  "outllook.com": "outlook.com",
  "outlook.co": "outlook.com",
  "outlook.con": "outlook.com",
  "iclod.com": "icloud.com",
  "iclould.com": "icloud.com",
  "icloud.co": "icloud.com",
};

/**
 * Email format, a shade stricter than `z.email()` alone. Used everywhere an
 * address is entered.
 */
export const emailSchema = z
  .email("Enter a valid email address")
  .max(200, "Email address is too long")
  .refine(
    (value) =>
      !(value.split("@")[1] ?? "")
        .split(".")
        .some((label) => label.startsWith("-") || label.endsWith("-")),
    { message: "Enter a valid email address" },
  );

/**
 * Address for a NEW account (US-101 registration, US-202 invites). Adds the
 * typo guard on top of the format check so the form rejects a mistyped domain
 * before any API call is made. Sign-in and password-reset deliberately skip
 * this — an account that already exists must stay reachable.
 */
export const newAccountEmailSchema = emailSchema.superRefine((value, ctx) => {
  const domain = value.split("@")[1]?.toLowerCase() ?? "";
  const intended = DOMAIN_TYPOS[domain];
  if (intended) {
    ctx.addIssue({
      code: "custom",
      message: `Did you mean @${intended}? Mail sent to “${domain}” will not arrive.`,
    });
  }
});

// US-206: minimum 8 characters, at least one letter and one number.
export const passwordSchema = z
  .string()
  .min(8, "At least 8 characters")
  .max(72)
  .regex(/[A-Za-z]/, "Must contain a letter")
  .regex(/\d/, "Must contain a number");

export const registerSchema = z.object({
  company: z.object({
    name: z.string().min(2).max(120),
    type: z.enum(COMPANY_TYPES),
    country: z.string().min(2).max(56),
    registrationNumber: z.string().min(2).max(64),
    address: z.string().min(4).max(240),
    // US-101 lists Phone among the captured registration fields.
    contactPhone: z.string().min(7, "At least 7 digits").max(32),
  }),
  admin: z.object({
    name: z.string().min(2).max(80),
    email: newAccountEmailSchema,
    password: passwordSchema,
  }),
});
export type RegisterInput = z.infer<typeof registerSchema>;

export const loginPasswordSchema = z.object({
  email: emailSchema,
  password: z.string().min(1).max(72),
});

export const loginOtpSchema = z.object({
  email: emailSchema,
  otp: z.string().regex(/^\d{6}$/, "6-digit code"),
});

export const otpRequestSchema = z.object({ email: emailSchema });

export const forgotPasswordSchema = z.object({ email: emailSchema });

export const resetPasswordSchema = z.object({
  token: z.string().min(20).max(200),
  password: passwordSchema,
});

export const acceptInviteSchema = z.object({
  token: z.string().min(20).max(200),
  name: z.string().min(2).max(80),
  password: passwordSchema,
});

export const changePasswordSchema = z.object({
  currentPassword: z.string().min(1).max(72),
  newPassword: passwordSchema,
});

export const whatsappSchema = z.object({
  // E.164
  number: z.string().regex(/^\+[1-9]\d{6,14}$/, "Use international format, e.g. +256700000000"),
});

export const inviteSchema = z.object({
  email: newAccountEmailSchema,
  role: z.enum(COMPANY_ROLES),
});
