# Instructions

- Following Playwright test failed.
- Explain why, be concise, respect Playwright best practices.
- Provide a snippet of code with the fix, if possible.

# Test info

- Name: auth-flows.spec.ts >> logout >> ends the session and the app is closed again
- Location: e2e/auth-flows.spec.ts:132:7

# Error details

```
Test timeout of 45000ms exceeded.
```

# Page snapshot

```yaml
- generic [active] [ref=e1]:
  - generic [ref=e2]:
    - banner [ref=e3]:
      - generic [ref=e4]:
        - link "Nashr" [ref=e5]:
          - /url: /en
        - group "Language" [ref=e7]:
          - link "العربية" [ref=e8]:
            - /url: /ar/app/login
            - text: عربي
          - link "English" [ref=e9]:
            - /url: /en/app/login
            - text: EN
    - main [ref=e10]:
      - generic [ref=e11]:
        - heading "Log in" [level=1] [ref=e12]
        - generic [ref=e13]:
          - textbox "Email" [ref=e14]
          - textbox "Password" [ref=e15]
          - button "Log in" [ref=e16] [cursor=pointer]
          - link "Forgot your password?" [ref=e17]:
            - /url: /en/app/forgot
        - paragraph [ref=e18]:
          - text: No account?
          - link "Create one" [ref=e19]:
            - /url: /en/app/signup
  - alert [ref=e20]
```