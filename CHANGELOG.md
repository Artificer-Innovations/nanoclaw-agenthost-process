# Changelog

## 0.1.1

### Patch Changes

- [#7](https://github.com/Artificer-Innovations/nanoclaw-agenthost-process/pull/7) [`d10b38d`](https://github.com/Artificer-Innovations/nanoclaw-agenthost-process/commit/d10b38d2d38365801680f5ae072db09b757e6ead) Thanks [@ZappoMan](https://github.com/ZappoMan)! - Collapse blank-line runs left in `src/index.ts` after process boot-block uninstall.

- Harden uninstall import scanning (side-effect imports, sorted readdir, fail-closed) and CRLF-tolerant boot-block blank collapse.

- [#7](https://github.com/Artificer-Innovations/nanoclaw-agenthost-process/pull/7) [`d10b38d`](https://github.com/Artificer-Innovations/nanoclaw-agenthost-process/commit/d10b38d2d38365801680f5ae072db09b757e6ead) Thanks [@ZappoMan](https://github.com/ZappoMan)! - Detect require() and dynamic import() when deciding whether to keep consumer runtime deps.

- [#7](https://github.com/Artificer-Innovations/nanoclaw-agenthost-process/pull/7) [`d10b38d`](https://github.com/Artificer-Innovations/nanoclaw-agenthost-process/commit/d10b38d2d38365801680f5ae072db09b757e6ead) Thanks [@ZappoMan](https://github.com/ZappoMan)! - Only remove consumer runtime deps when the pin matches ours and nothing else imports them.

- [#7](https://github.com/Artificer-Innovations/nanoclaw-agenthost-process/pull/7) [`d10b38d`](https://github.com/Artificer-Innovations/nanoclaw-agenthost-process/commit/d10b38d2d38365801680f5ae072db09b757e6ead) Thanks [@ZappoMan](https://github.com/ZappoMan)! - Remove `smol-toml` (and other consumer runtime deps this package added) from the fork `package.json` on uninstall once `src/process-runtime.ts` is gone.

## 0.1.0

- Initial release: `process` RuntimeDriver, installer with WORKING_ROOT patches, skill `/add-agenthost-process`
