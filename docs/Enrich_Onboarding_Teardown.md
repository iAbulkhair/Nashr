# Enrich Labs (Helena): signup and onboarding teardown

Captured 2026-09-18 from a fresh account created by the founder. One section per screen, in order. Purpose: rebuild Nashr's signup and onboarding on the same flow, adapted for the Gulf (phone and WhatsApp, Arabic first, Salla and Zid).

Legend: **Copy** = text on screen as shown. **Fields** = inputs and whether required. **Nashr** = what we take, change or skip.

## 0. Entry points (homepage, enrichlabs.ai)
- Page title: "Helena - The last marketing hire you'll ever make."
- Hero has a URL-first input: placeholder "Enter your website URL", submit button "Continue with this website". The visitor gives a website before any account form.
- Header link "Start free" goes to `agent.enrichlabs.ai/marketing/register` and carries attribution parameters (landing source, visitor id, homepage experiment and variant), so they A/B test the hero and attribute signups to it.
- Secondary hook on the page: "Marketing tools, no signup needed" (free tools as a no-friction entry).
- **Nashr:** we already have URL-first brand import and free tools. Missing: the URL box in the marketing hero that carries the URL into signup, and signup attribution parameters saved on the user record.

## 1. Register (agent.enrichlabs.ai/marketing/register)
Source: read unstyled from the in-app browser (its scripts and images were blocked there), so layout is unknown; copy and fields are exact.
- **Copy:** logo "Helena". H1 "Meet Helena, your first self-improving AI marketer". Sub: "SEO, ads, social, and email – running while you sleep, reporting back every morning." One testimonial line with a name under it. Trust row "BUILT BY THE TEAM FROM" + six company logos. Footer: "Already have an account? Log in" and "By continuing, you agree to our Terms of Service and Privacy Policy."
- **Fields:** button "Continue with Google"; divider "or continue with"; one input "Work email" (placeholder name@company.com); button "Start Free". No name, no phone, no password on the first screen.
- **What the loaded script names reveal:** a password step with a live requirements list comes after the email; an app-language selector exists; tracking is Mixpanel + GA4 + Meta Pixel; affiliate attribution through Rewardful.
- **Nashr:** today we ask name, phone, email and password on one screen. Take: email-only first step, Google sign-in, one testimonial and a trust row beside the form, legal line under the button. Change: keep phone, but ask for it later (WhatsApp step in onboarding), not on the first screen.
