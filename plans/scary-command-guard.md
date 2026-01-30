# Plan: scary-command-guard

- Audit guard patterns for false positives/negatives; align with dangerous
  overrides from Claude/Factory/Amp/OpenCode.
- Refactor matching to command-aware parsing (segments/pipelines) to avoid
  keywords in args.
- Introduce severity (ask/deny) + typed override for ultra-dangerous ops.
- Add allow-once/always (session) approvals + persist via custom entries.
- Add CLI flag to bypass guard; block scary commands in non-UI unless bypass
  set.
- Trim/replace overly broad rules (deploy, rm -f) and add targeted
  deploy/publish rules.

Questions: none
