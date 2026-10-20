# وكيل التشغيل لذكين: خطوات المؤسس

الوكيل يراقب ويرسل لك على تيليجرام. ما ينفّذ أي شيء بنفسه. الإجراء الوحيد (فتح issue في GitHub) ينفّذه التطبيق بعد ما تضغط «موافق». التفاصيل التقنية موجودة في `docs/system/flows.md` قسم 99.

الترتيب مهم: لازم المسارات الجديدة تكون شغّالة على thakeen.com قبل تشغيل الوكيل. يعني بعد الإصدار اللي تدمجه أنت.

## 1. تيليجرام (مرة وحدة)

1. في تيليجرام افتح `@BotFather`، أرسل `/newbot`، وخذ مفتاح البوت. هذا `TELEGRAM_BOT_TOKEN`.
2. افتح البوت الجديد وأرسل له `/start`.
3. من الطرفية عندك (مو في المحادثة)، اعرف رقم محادثتك:

```bash
read -rs TG && curl -s "https://api.telegram.org/bot$TG/getUpdates" | jq '.result[-1].message.chat.id'
```

الرقم اللي يطلع هو `TELEGRAM_CHAT_ID`.

4. ولّد سرّين عشوائيين، واحد لكل متغير. لا تلصقهم في أي محادثة:

```bash
openssl rand -hex 32
```

الأول `OPS_AGENT_TOKEN` والثاني `TELEGRAM_WEBHOOK_SECRET`.

## 2. مفتاحين GitHub من نوع Fine-grained

- مفتاح الخادم `OPS_GITHUB_TOKEN`: المستودع `iAbulkhair/Nashr` بس، والصلاحية Issues: Read and write. ما يحتاج غيرها.
- مفتاح الوكيل (للقراءة بس): المستودع نفسه، والصلاحيات Contents: Read و Pull requests: Read و Actions: Read و Metadata: Read. هذا ينحط في خزنة الوكيل، مو في Hostinger.

## 3. متغيرات Hostinger (بعد الإصدار)

حط الخمسة في إعدادات بيئة thakeen.com: `OPS_AGENT_TOKEN` و`TELEGRAM_BOT_TOKEN` و`TELEGRAM_CHAT_ID` و`TELEGRAM_WEBHOOK_SECRET` و`OPS_GITHUB_TOKEN`. وبعدها اربط البوت بمسار الأزرار من طرفيتك:

```bash
read -rs TG && read -rs HOOK && curl -s "https://api.telegram.org/bot$TG/setWebhook" -d url=https://thakeen.com/api/ops/telegram/callback -d secret_token="$HOOK" -d 'allowed_updates=["callback_query"]'
```

لازم يرجع `"ok":true`.

## 4. إنشاء الوكيل (`ant` 1.34 أو أحدث، من جذر المستودع)

الخطوة الأولى: الوكيل والبيئة والخزنة. أول شيء شوف الخطة بدون تنفيذ، وبعدها نفّذ:

```bash
ant apply --dry-run -v agents/thakeen-ops/agent.md agents/thakeen-ops/environment.yaml agents/thakeen-ops/vault.yaml
```

```bash
ant apply agents/thakeen-ops/agent.md agents/thakeen-ops/environment.yaml agents/thakeen-ops/vault.yaml
```

الخطوة الثانية: المفتاحين في الخزنة. شغّل كل بلوك لحاله، والصق السر لما يطلب منك (ما يظهر على الشاشة).

مفتاح التشغيل، يروح لـ thakeen.com و www.thakeen.com فقط:

```bash
VAULT_ID=$(jq -r '.resources["./agents/thakeen-ops/vault.yaml"].id' claude-lock.json) && read -rs CMA_OPS && export CMA_OPS && jq -n '{display_name:"Thakeen ops", auth:{type:"environment_variable", secret_name:"OPS_AGENT_TOKEN", secret_value:(env.CMA_OPS // error("CMA_OPS is not set")), networking:{type:"limited", allowed_hosts:["thakeen.com","www.thakeen.com"]}, injection_location:{header:true}}}' | ant beta:vaults:credentials create --vault-id "$VAULT_ID"
```

مفتاح GitHub للقراءة، يروح لـ api.github.com فقط:

```bash
VAULT_ID=$(jq -r '.resources["./agents/thakeen-ops/vault.yaml"].id' claude-lock.json) && read -rs CMA_GH && export CMA_GH && jq -n '{display_name:"GitHub read-only", auth:{type:"environment_variable", secret_name:"GITHUB_TOKEN", secret_value:(env.CMA_GH // error("CMA_GH is not set")), networking:{type:"limited", allowed_hosts:["api.github.com"]}, injection_location:{header:true}}}' | ant beta:vaults:credentials create --vault-id "$VAULT_ID"
```

بعدها امسح المتغيرين من الطرفية:

```bash
unset CMA_OPS CMA_GH
```

الخطوة الثالثة: حط رقم الخزنة (`vlt_...` من `claude-lock.json`) في `vault_ids` داخل ملفي الجدولة. بعدها أنشئ كل جدولة وأوقفها في نفس الأمر، عشان ما تشتغل قبل التجربة:

```bash
ant apply agents/thakeen-ops/deployment-checks.yaml && ant beta:deployments pause --deployment-id "$(jq -r '.resources["./agents/thakeen-ops/deployment-checks.yaml"].id' claude-lock.json)"
```

```bash
ant apply agents/thakeen-ops/deployment-morning.yaml && ant beta:deployments pause --deployment-id "$(jq -r '.resources["./agents/thakeen-ops/deployment-morning.yaml"].id' claude-lock.json)"
```

## 5. تجربة تحت المراقبة، وبعدها التفعيل

شغّل تقرير الصباح مرة وحدة يدوياً. التشغيل اليدوي يشتغل حتى والجدولة موقوفة:

```bash
ant beta:deployments run --deployment-id "$(jq -r '.resources["./agents/thakeen-ops/deployment-morning.yaml"].id' claude-lock.json)"
```

شيّك على ثلاث أشياء: التقرير وصلك على تيليجرام، والأرقام اللي فيه نفس اللي في لوحة المؤسس، والتكلفة في Console أقل من دولار. إذا كله تمام، فعّل الجدولتين:

```bash
ant beta:deployments unpause --deployment-id "$(jq -r '.resources["./agents/thakeen-ops/deployment-checks.yaml"].id' claude-lock.json)"
```

```bash
ant beta:deployments unpause --deployment-id "$(jq -r '.resources["./agents/thakeen-ops/deployment-morning.yaml"].id' claude-lock.json)"
```

`claude-lock.json` يتسجّل في المستودع بعد أول `ant apply`.
