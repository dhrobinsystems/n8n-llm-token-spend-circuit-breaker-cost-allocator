# ⚠️ Disclaimer & Liability Limitation

**Use at your own risk.** The code, workflows, and scripts in this repository (**n8n-llm-token-spend-circuit-breaker-cost-allocator**) are provided for educational and architectural demonstration purposes.

**No Liability:** The author and dhRobin Systems accept no responsibility or liability for any direct, indirect, incidental, or consequential damages that result from using, misusing, or deploying these scripts. That includes AI provider charges above any configured cap; budgets that fail to stop spend because of concurrency, misconfiguration, stale prices or provider-side billing differences; requests that are throttled, downgraded or answered by fallback rules instead of a model; incorrect cost attribution or allocation between clients, campaigns or cost centers; prompts or outputs disclosed to a provider or channel; and business decisions taken on the basis of automated cost reports.

**No Warranty:** All software, n8n JSON blueprints, JavaScript modules, pricing tables, fallback rules, prompts and sample payloads are provided "AS IS", without warranty of any kind, express or implied. This includes, but is not limited to, warranties of merchantability, fitness for a particular purpose, and non-infringement. Cost figures in this repository are **estimates and internal attribution only**. They are not invoices. The bundled per-model prices are a dated snapshot (`PRICING_AS_OF`) that providers can change at any time. Pre-flight estimates are approximations, and provider usage, discounts, taxes, data-residency multipliers and billing can differ from what this workflow records. Your provider's invoice and usage console are always authoritative.

**Not a Spending Guarantee:** The circuit breaker reduces the risk of runaway spend. It cannot guarantee that spend stays below a cap. Concurrent executions, retries outside this workflow, other applications sharing the same API keys, provider-side delays in usage reporting, and timeouts that are billed but not answered can all push actual spend past a configured limit. Always set hard spending limits and alerts in your OpenAI and Anthropic account consoles as well.

**Production Testing Required:** Always test thoroughly in an isolated staging environment, such as a separate n8n instance, dedicated low-limit API keys or projects, and a private test Slack or Teams channel, with `SANDBOX_MODE=true` and `DRY_RUN=true` enabled, before you connect live OpenAI or Anthropic credentials or set `LLM_CALLS_ENABLED=true` or `ALERTS_ENABLED=true`. Treat every fallback output (regex classification, rule-based scores, template replies, extractive summaries) and every model output as a draft that a person must review before it's relied on or sent to a customer.

**Third-Party APIs & Compliance:** You alone are responsible for complying with the terms of service, usage policies, rate limits, data privacy regulations (GDPR/CCPA), data-processing agreements and security policies of OpenAI, Anthropic, Slack, Microsoft, n8n, and any connected services. That includes confirming a lawful basis for sending prompts that may contain personal data to an AI provider, verifying that the built-in PII redaction is sufficient for your data (it is pattern-based and not exhaustive), configuring execution-data retention, keeping cost alerts in private channels, treating API keys and webhook URLs as secrets, and reviewing every automatically generated output and alert.

The full disclaimer is also available in [DISCLAIMER.md](DISCLAIMER.md).

## License

Released under the MIT License. Copyright (c) 2026 DH Robin (dhRobin Systems). See [LICENSE](LICENSE).

---

Full text: DISCLAIMER.md · Licensed under the MIT License. License: MIT © 2026 DH Robin (dhRobin Systems) · Provided as-is, see the disclaimer.
