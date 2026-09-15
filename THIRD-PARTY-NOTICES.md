# 第三方软件声明

本项目的 Docker 镜像包含以下第三方软件包。它们的许可证要求**在再分发时保留版权声明与许可证文本**，本文件即为该义务的履行方式。

运行时依赖共 **205** 个，全部为宽松许可证（无 copyleft）。开发依赖不会被打进镜像，因此不在此列。

> 本文件由 `node scripts/generate-notices.mjs` 自动生成，请勿手工编辑。
> CI 会校验它与当前依赖一致。

## 许可证汇总

| 许可证 | 包数量 |
| --- | --- |
| MIT | 164 |
| ISC | 25 |
| BlueOak-1.0.0 | 7 |
| BSD-3-Clause | 5 |
| Apache-2.0 | 2 |
| 0BSD | 1 |
| MIT AND ISC | 1 |

各项义务：**MIT / ISC / BSD / BlueOak** 要求保留版权与许可证文本；**Apache-2.0** 还要求在存在 `NOTICE` 文件时一并保留（当前依赖均不含 NOTICE）。以上各项均已通过本文件与镜像内的原始许可证文件满足。

## 完整清单

| 包 | 版本 | 许可证 | 版权方 |
| --- | --- | --- | --- |
| @babel/runtime | 7.29.7 | MIT | The Babel Team (https://babel.dev/team) |
| @fastify/accept-negotiator | 2.1.0 | MIT | Aras Abbasi <aras.abbasi@gmail.com> |
| @fastify/ajv-compiler | 4.0.6 | MIT | Manuel Spigolon <behemoth89@gmail.com> (https://github.com/E |
| @fastify/cors | 10.1.0 | MIT | Tomas Della Vedova - @delvedor (http://delved.org) |
| @fastify/error | 4.2.0 | MIT | Tomas Della Vedova |
| @fastify/fast-json-stringify-compiler | 5.1.0 | MIT | Manuel Spigolon <manuel.spigolon@nearform.com> (https://gith |
| @fastify/forwarded | 3.0.2 | MIT | Douglas Christopher Wilson <doug@somethingdoug.com> |
| @fastify/merge-json-schemas | 0.2.1 | MIT | Ivan Tymoshenko <ivan@tymoshenko.me> |
| @fastify/proxy-addr | 5.1.0 | MIT | Douglas Christopher Wilson <doug@somethingdoug.com> |
| @fastify/send | 4.1.1 | MIT | TJ Holowaychuk <tj@vision-media.ca> |
| @fastify/static | 8.3.0 | MIT | Tommaso Allevi - @allevo |
| @fastify/websocket | 11.3.0 | MIT | Matteo Collina <hello@matteocollina.com> |
| @floating-ui/core | 1.8.0 | MIT | atomiks |
| @floating-ui/dom | 1.8.0 | MIT | atomiks |
| @floating-ui/react-dom | 2.1.9 | MIT | atomiks |
| @floating-ui/utils | 0.2.12 | MIT | atomiks |
| @isaacs/cliui | 9.0.0 | BlueOak-1.0.0 | — |
| @lukeed/ms | 2.0.2 | MIT | Luke Edwards |
| @pinojs/redact | 0.4.0 | MIT | Matteo Collina <hello@matteocollina.com> |
| @radix-ui/number | 1.1.3 | MIT | — |
| @radix-ui/primitive | 1.1.7 | MIT | — |
| @radix-ui/react-accordion | 1.2.20 | MIT | — |
| @radix-ui/react-arrow | 1.1.15 | MIT | — |
| @radix-ui/react-checkbox | 1.3.11 | MIT | — |
| @radix-ui/react-collapsible | 1.1.20 | MIT | — |
| @radix-ui/react-collection | 1.1.15 | MIT | — |
| @radix-ui/react-compose-refs | 1.1.5 | MIT | — |
| @radix-ui/react-context | 1.2.2 | MIT | — |
| @radix-ui/react-dialog | 1.1.23 | MIT | — |
| @radix-ui/react-direction | 1.1.4 | MIT | — |
| @radix-ui/react-dismissable-layer | 1.1.19 | MIT | — |
| @radix-ui/react-dropdown-menu | 2.1.24 | MIT | — |
| @radix-ui/react-focus-guards | 1.1.6 | MIT | — |
| @radix-ui/react-focus-scope | 1.1.16 | MIT | — |
| @radix-ui/react-id | 1.1.4 | MIT | — |
| @radix-ui/react-label | 2.1.15 | MIT | — |
| @radix-ui/react-menu | 2.1.24 | MIT | — |
| @radix-ui/react-popover | 1.1.23 | MIT | — |
| @radix-ui/react-popper | 1.3.7 | MIT | — |
| @radix-ui/react-portal | 1.1.17 | MIT | — |
| @radix-ui/react-presence | 1.1.10 | MIT | — |
| @radix-ui/react-primitive | 2.1.10 | MIT | — |
| @radix-ui/react-roving-focus | 1.1.19 | MIT | — |
| @radix-ui/react-scroll-area | 1.2.18 | MIT | — |
| @radix-ui/react-select | 2.3.7 | MIT | — |
| @radix-ui/react-separator | 1.1.15 | MIT | — |
| @radix-ui/react-slider | 1.4.7 | MIT | — |
| @radix-ui/react-slot | 1.3.3 | MIT | — |
| @radix-ui/react-switch | 1.3.7 | MIT | — |
| @radix-ui/react-tabs | 1.1.21 | MIT | — |
| @radix-ui/react-tooltip | 1.2.16 | MIT | — |
| @radix-ui/react-use-callback-ref | 1.1.4 | MIT | — |
| @radix-ui/react-use-controllable-state | 1.2.6 | MIT | — |
| @radix-ui/react-use-effect-event | 0.0.5 | MIT | — |
| @radix-ui/react-use-is-hydrated | 0.1.3 | MIT | — |
| @radix-ui/react-use-layout-effect | 1.1.4 | MIT | — |
| @radix-ui/react-use-previous | 1.1.4 | MIT | — |
| @radix-ui/react-use-rect | 1.1.4 | MIT | — |
| @radix-ui/react-use-size | 1.1.4 | MIT | — |
| @radix-ui/react-visually-hidden | 1.2.11 | MIT | — |
| @radix-ui/rect | 1.1.3 | MIT | — |
| @remix-run/router | 1.23.4 | MIT | Remix Software <hello@remix.run> |
| @types/d3-array | 3.2.2 | MIT | — |
| @types/d3-color | 3.1.3 | MIT | — |
| @types/d3-ease | 3.0.2 | MIT | — |
| @types/d3-interpolate | 3.0.4 | MIT | — |
| @types/d3-path | 3.1.1 | MIT | — |
| @types/d3-scale | 4.0.9 | MIT | — |
| @types/d3-shape | 3.2.0 | MIT | — |
| @types/d3-time | 3.0.4 | MIT | — |
| @types/d3-timer | 3.0.2 | MIT | — |
| abstract-logging | 2.0.1 | MIT | James Sumners <james.sumners@gmail.com> |
| ajv | 8.20.0 | MIT | Evgeny Poberezkin |
| ajv-formats | 3.0.1 | MIT | Evgeny Poberezkin |
| aria-hidden | 1.2.6 | MIT | Anton Korzunov <thekashey@gmail.com> |
| atomic-sleep | 1.0.0 | MIT | David Mark Clements (@davidmarkclem) |
| avvio | 9.3.0 | MIT | Matteo Collina <hello@matteocollina.com> |
| balanced-match | 4.0.4 | MIT | — |
| brace-expansion | 5.0.12 | MIT | — |
| class-variance-authority | 0.7.1 | Apache-2.0 | Joe Bell (https://joebell.co.uk) |
| clsx | 2.1.1 | MIT | Luke Edwards |
| cmdk | 1.1.1 | MIT | Paco |
| content-disposition | 0.5.4 | MIT | Douglas Christopher Wilson <doug@somethingdoug.com> |
| cookie | 1.1.1 | MIT | Roman Shtylman <shtylman@gmail.com> |
| cross-spawn | 7.0.6 | MIT | André Cruz <andre@moxy.studio> |
| csstype | 3.2.3 | MIT | Fredrik Nicol <fredrik.nicol@gmail.com> |
| d3-array | 3.2.4 | ISC | Mike Bostock |
| d3-color | 3.1.0 | ISC | Mike Bostock |
| d3-ease | 3.0.1 | BSD-3-Clause | Mike Bostock |
| d3-format | 3.1.2 | ISC | Mike Bostock |
| d3-interpolate | 3.0.1 | ISC | Mike Bostock |
| d3-path | 3.1.0 | ISC | Mike Bostock |
| d3-scale | 4.0.2 | ISC | Mike Bostock |
| d3-shape | 3.2.0 | ISC | Mike Bostock |
| d3-time | 3.1.0 | ISC | Mike Bostock |
| d3-time-format | 4.1.0 | ISC | Mike Bostock |
| d3-timer | 3.0.1 | ISC | Mike Bostock |
| decimal.js-light | 2.5.1 | MIT | Michael Mclaughlin |
| depd | 2.0.0 | MIT | Douglas Christopher Wilson <doug@somethingdoug.com> |
| dequal | 2.0.3 | MIT | Luke Edwards |
| detect-node-es | 1.1.0 | MIT | Ilya Kantor |
| dom-helpers | 5.2.1 | MIT | Jason Quense |
| duplexify | 4.1.3 | MIT | Mathias Buus |
| end-of-stream | 1.4.5 | MIT | Mathias Buus <mathiasbuus@gmail.com> |
| esbuild | 0.28.2 | MIT | — |
| escape-html | 1.0.3 | MIT | — |
| eventemitter3 | 4.0.7 | MIT | Arnout Kazemier |
| fancy-canvas | 2.1.0 | MIT | smakarov@tradingview.com |
| fast-decode-uri-component | 1.0.1 | MIT | Tomas Della Vedova - @delvedor (http://delved.org) |
| fast-deep-equal | 3.1.3 | MIT | Evgeny Poberezkin |
| fast-equals | 5.4.2 | MIT | Tony Quetano |
| fast-json-stringify | 7.0.1 | MIT | Matteo Collina <hello@matteocollina.com> |
| fast-querystring | 1.1.2 | MIT | Yagiz Nizipli <yagiz@nizipli.com> |
| fast-uri | 4.1.5 | BSD-3-Clause | Vincent Le Goff <vince.legoff@gmail.com> (https://github.com |
| fastify | 5.12.4 | MIT | Matteo Collina <hello@matteocollina.com> |
| fastify-plugin | 5.1.0 | MIT | Tomas Della Vedova - @delvedor (http://delved.org) |
| fastq | 1.20.3 | ISC | Matteo Collina <hello@matteocollina.com> |
| find-my-way | 9.9.0 | MIT | Tomas Della Vedova - @delvedor (http://delved.org) |
| foreground-child | 3.3.1 | ISC | Isaac Z. Schlueter <i@izs.me> (http://blog.izs.me/) |
| get-nonce | 1.0.1 | MIT | Anton Korzunov <thekashey@gmail.com> |
| glob | 11.1.0 | BlueOak-1.0.0 | Isaac Z. Schlueter <i@izs.me> (https://blog.izs.me/) |
| http-errors | 2.0.1 | MIT | Jonathan Ong <me@jongleberry.com> (http://jongleberry.com) |
| inherits | 2.0.4 | ISC | — |
| internmap | 2.0.3 | ISC | Mike Bostock |
| ipaddr.js | 2.5.0 | MIT | whitequark <whitequark@whitequark.org> |
| isexe | 2.0.0 | ISC | Isaac Z. Schlueter <i@izs.me> (http://blog.izs.me/) |
| jackspeak | 4.2.3 | BlueOak-1.0.0 | Isaac Z. Schlueter <i@izs.me> |
| js-tokens | 4.0.0 | MIT | Simon Lydell |
| json-schema-ref-resolver | 3.0.0 | MIT | Ivan Tymoshenko <ivan@tymoshenko.me> |
| json-schema-traverse | 1.0.0 | MIT | Evgeny Poberezkin |
| light-my-request | 6.6.0 | BSD-3-Clause | Tomas Della Vedova - @delvedor (http://delved.org) |
| lightweight-charts | 4.2.3 | Apache-2.0 | TradingView, Inc. |
| lodash | 4.18.1 | MIT | John-David Dalton <john.david.dalton@gmail.com> |
| loose-envify | 1.4.0 | MIT | Andres Suarez <zertosh@gmail.com> |
| lru-cache | 5.1.1 | ISC | Isaac Z. Schlueter <i@izs.me> |
| lucide-react | 1.46.0 | ISC | Eric Fennis |
| mime | 3.0.0 | MIT | Robert Kieffer |
| minimatch | 10.2.6 | BlueOak-1.0.0 | Isaac Z. Schlueter <i@izs.me> (http://blog.izs.me) |
| minipass | 7.1.3 | BlueOak-1.0.0 | Isaac Z. Schlueter <i@izs.me> (http://blog.izs.me/) |
| mnemonist | 0.40.0 | MIT | Guillaume Plique |
| object-assign | 4.1.1 | MIT | Sindre Sorhus |
| obliterator | 2.0.5 | MIT | Guillaume Plique |
| on-exit-leak-free | 2.1.2 | MIT | Matteo Collina <hello@matteocollina.com> |
| once | 1.4.0 | ISC | Isaac Z. Schlueter <i@izs.me> (http://blog.izs.me/) |
| package-json-from-dist | 1.0.1 | BlueOak-1.0.0 | Isaac Z. Schlueter <i@izs.me> (https://izs.me) |
| path-key | 3.1.1 | MIT | Sindre Sorhus |
| path-scurry | 2.0.2 | BlueOak-1.0.0 | Isaac Z. Schlueter <i@izs.me> (https://blog.izs.me) |
| pino | 10.3.1 | MIT | Matteo Collina <hello@matteocollina.com> |
| pino-abstract-transport | 3.0.0 | MIT | Matteo Collina <hello@matteocollina.com> |
| pino-std-serializers | 7.1.0 | MIT | James Sumners <james.sumners@gmail.com> |
| process-warning | 5.1.0 | MIT | Tomas Della Vedova |
| prop-types | 15.8.1 | MIT | — |
| quick-format-unescaped | 4.0.4 | MIT | David Mark Clements |
| react | 18.3.1 | MIT | — |
| react-dom | 18.3.1 | MIT | — |
| react-is | 18.3.1 | MIT | — |
| react-remove-scroll | 2.7.2 | MIT | Anton Korzunov <thekashey@gmail.com> |
| react-remove-scroll-bar | 2.3.8 | MIT | Anton Korzunov <thekashey@gmail.com> |
| react-router | 6.30.6 | MIT | Remix Software <hello@remix.run> |
| react-router-dom | 6.30.6 | MIT | Remix Software <hello@remix.run> |
| react-smooth | 4.0.4 | MIT | JasonHzq |
| react-style-singleton | 2.2.3 | MIT | Anton Korzunov (thekashey@gmail.com) |
| react-transition-group | 4.4.5 | BSD-3-Clause | — |
| readable-stream | 3.6.2 | MIT | — |
| real-require | 0.2.0 | MIT | Paolo Insogna <shogun@cowtech.it> |
| recharts | 2.15.4 | MIT | recharts group |
| recharts-scale | 0.4.5 | MIT | recharts group |
| require-from-string | 2.0.2 | MIT | Vsevolod Strukchinsky |
| ret | 0.5.0 | MIT | fent <fentbox@gmail.com> (https://github.com/fent) |
| reusify | 1.1.0 | MIT | Matteo Collina <hello@matteocollina.com> |
| rfdc | 1.4.1 | MIT | David Mark Clements <david.clements@nearform.com> |
| safe-buffer | 5.2.1 | MIT | Feross Aboukhadijeh |
| safe-regex2 | 5.1.1 | MIT | James Halliday |
| safe-stable-stringify | 2.5.0 | MIT | Ruben Bridgewater |
| scheduler | 0.23.2 | MIT | — |
| secure-json-parse | 4.1.0 | BSD-3-Clause | Eran Hammer <eran@sideway.com> |
| semver | 6.3.1 | ISC | GitHub Inc. |
| set-cookie-parser | 2.7.2 | MIT | Nathan Friedly |
| setprototypeof | 1.2.0 | ISC | Wes Todd |
| shebang-command | 2.0.0 | MIT | Kevin Mårtensson |
| shebang-regex | 3.0.0 | MIT | Sindre Sorhus |
| signal-exit | 4.1.0 | ISC | Ben Coe <ben@npmjs.com> |
| sonic-boom | 4.2.1 | MIT | Matteo Collina <hello@matteocollina.com> |
| sonner | 2.0.8 | MIT | Emil Kowalski <e@emilkowal.ski> |
| split2 | 4.2.0 | ISC | Matteo Collina <hello@matteocollina.com> |
| statuses | 2.0.2 | MIT | — |
| stream-shift | 1.0.3 | MIT | Mathias Buus (@mafintosh) |
| string_decoder | 1.3.0 | MIT | — |
| tailwind-merge | 3.7.0 | MIT | Dany Castillo |
| thread-stream | 4.2.0 | MIT | Matteo Collina <hello@matteocollina.com> |
| tiny-invariant | 1.3.3 | MIT | Alex Reardon <alexreardon@gmail.com> |
| toad-cache | 3.7.4 | MIT | Igor Savin <kibertoad@gmail.com> |
| toidentifier | 1.0.1 | MIT | Douglas Christopher Wilson <doug@somethingdoug.com> |
| tslib | 2.8.1 | 0BSD | Microsoft Corp. |
| tsx | 4.23.13 | MIT | Hiroki Osame |
| use-callback-ref | 1.3.3 | MIT | theKashey <thekashey@gmail.com> |
| use-sidecar | 1.1.3 | MIT | theKashey <thekashey@gmail.com> |
| util-deprecate | 1.0.2 | MIT | Nathan Rajlich <nathan@tootallnate.net> (http://n8.io/) |
| victory-vendor | 36.9.2 | MIT AND ISC | Formidable |
| which | 2.0.2 | ISC | Isaac Z. Schlueter <i@izs.me> (http://blog.izs.me) |
| wrappy | 1.0.2 | ISC | Isaac Z. Schlueter <i@izs.me> (http://blog.izs.me/) |
| ws | 8.21.3 | MIT | Einar Otto Stangvik <einaros@gmail.com> (http://2x.io) |
| yallist | 3.1.1 | ISC | Isaac Z. Schlueter <i@izs.me> (http://blog.izs.me/) |
| zod | 3.25.76 | MIT | Colin McDonnell <zod@colinhacks.com> |
| zustand | 5.0.15 | MIT | Paul Henschel |

---

完整的许可证文本随各软件包一同分发（位于 `node_modules/<包名>/LICENSE`），并已包含在发布的镜像内。
