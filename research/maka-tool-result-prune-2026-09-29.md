# Maka Tool Result Prune：博客语义与当前实现（2026-09-29）

范围：核对 Maka 一手资料，判断是否应把本项目的“近期结果常驻”、占位符字节数／哈希及检索接口改成博客的样子。Maka 仓库资料按 `2f32205528a4436783c800715261d4b6e286023d` 固定版本引用；以下“不必对齐”是设计建议，不是本项目的实现审计。

## 核实结果

1. **“近期结果保留完整”不是所有大结果的硬性规则。** [博客的 History Replay 段](https://github.com/apache/maka/blob/2f32205528a4436783c800715261d4b6e286023d/docs/blogs/log-is-the-runtime.md#L198-L203) 写“Recent tool invocations remain verbatim”，但同一段也写 Active Turn 的超大结果“pruned immediately prior to the next reasoning step”。因此，“近期”只描述历史重放的一种窗口策略，不能覆盖活跃轮已经裁剪的结果；博客没有给近期窗口的轮数、时间或阈值。[较新的架构说明](https://github.com/apache/maka/blob/2f32205528a4436783c800715261d4b6e286023d/docs/architecture/llm-compaction-events-log-projection-draft.md#L448-L458) 更明确：当前轮与历史轮用同一个固定大小规则，超过 7,500 UTF-8 字节的序列化文本变成有界首页和 `next`。所以不应为了逐字贴合博客而强制让所有近期大结果跨轮常驻；应按模型成本和实际任务需要选择是否保留短期完整窗口。

2. **博客未规定哈希必须对应“原始结果 JSON”。** [博客](https://github.com/apache/maka/blob/2f32205528a4436783c800715261d4b6e286023d/docs/blogs/log-is-the-runtime.md#L186-L190) 只称占位符包含“byte size, content hash, and an authorized access handle”，未定义编码／规范化形式。[Maka 当前代码](https://github.com/apache/maka/blob/2f32205528a4436783c800715261d4b6e286023d/packages/runtime/src/tool-result-archive-transition.ts#L59-L65) 明确把 **effective durable model projection** 的序列化正文归档，因为它才是从模型视图中移走的正文；[哈希计算](https://github.com/apache/maka/blob/2f32205528a4436783c800715261d4b6e286023d/packages/runtime/src/tool-result-archive-transition.ts#L108-L123) 和[字节数计算](https://github.com/apache/maka/blob/2f32205528a4436783c800715261d4b6e286023d/packages/runtime/src/tool-result-archive-transition.ts#L232-L247) 都基于此正文，[读取时](https://github.com/apache/maka/blob/2f32205528a4436783c800715261d4b6e286023d/packages/runtime/src/ledger-tool-result-archive-reader.ts#L127-L139) 再验证正文大小和 SHA-256。因此占位符标识“可取回的模型正文”有依据。若本项目把 `.txt` 分片作为实际读取单位，标记其字节数／哈希并非违反博客；关键是字段命名、读取范围和验证对象一致，同时保留原始 JSON 的独立完整性元数据。

3. **Inspect、Query、Paginated Read 是博客里的能力划分，不是现行 API 必备清单。** [博客](https://github.com/apache/maka/blob/2f32205528a4436783c800715261d4b6e286023d/docs/blogs/log-is-the-runtime.md#L190-L195) 的原话是“separating inspection, structured querying, and paginated reading”，对应概览元数据／对象 schema、查找特定条目／字段、有界分页。[较新的架构说明](https://github.com/apache/maka/blob/2f32205528a4436783c800715261d4b6e286023d/docs/architecture/llm-compaction-events-log-projection-draft.md#L454-L458) 明确写“ArchiveRead, its inspect/query/search operations ... are removed without aliases”，改用 `Read(path, offset?, limit?)`、`next` 和会话内的 `maka://runtime/tool-results/<event-id>` 地址。因此本项目已提供有界续读时，没有必要为接口名字对齐而增设三个入口。若真实任务需要对结构化大结果按字段定位，再评估增加 Query；仅凭博客无法证明其必要性。

4. **稳定设计约束是归档先于替换、原始事实不被裁剪。** [博客](https://github.com/apache/maka/blob/2f32205528a4436783c800715261d4b6e286023d/docs/blogs/log-is-the-runtime.md#L196-L205) 明言“archive first, placeholder second”，失败保留完整结果，并指出裁剪只改模型投影、RuntimeEvent Log 保留原始输出，compaction 应总结真实事实。[较新架构说明](https://github.com/apache/maka/blob/2f32205528a4436783c800715261d4b6e286023d/docs/architecture/llm-compaction-events-log-projection-draft.md#L450-L458) 延续这些约束，且把替换表示为持久的投影 transition。

## 对本项目的建议

- **现有决策背景：** [#6](https://github.com/CxHsin/nailong-bot/issues/6) 明确要求同轮大结果即时裁剪；[#10](https://github.com/CxHsin/nailong-bot/issues/10) 明确要求近期历史保持当时的模型可见形态，已经卸载的结果继续使用引用；[#12](https://github.com/CxHsin/nailong-bot/issues/12) 保留约 2,048 token 的裁剪资格，并明确不增加 Inspect/Query。代码分别在 `src/pi-agent.ts` 的 `recordResult` / `afterToolCall`、`src/projection.ts` 的 `pruned` 判断、`src/runtime-log.ts` 的 `archivePlaceholder` / `archive` 和 `src/archive-read.ts` 的有界读取中落实这些选择。
- **近期窗口：暂不以“完全一致”为目标修改。** 当前大结果一生成就归档、后续跨轮仍给占位符，与 Maka 当前统一大小规则方向一致。若遇到模型在下一轮频繁回读同一结果、任务质量下降，再用观测数据决定是否添加短暂完整窗口；窗口也应受总上下文预算约束。
- **字节数／哈希：保留现有读取正文的校验口径。** 最好把占位符字段明示为“可读取分片正文”的大小和 SHA-256，避免读者误认是原始 JSON；原始结果的校验值留在独立元数据中。评估任何改名时需考虑历史占位符兼容。
- **读取接口：保留单个有界读取与续读。** 若将来出现大量结构化结果的定位需求，可增设针对字段／条目的 Query；无需仿照旧博客增加 Inspect 和 ArchiveRead。

## 仍不能从一手资料确认的点

- 博客没有给出“近期”窗口的精确长度，也没有承诺每个近期大型结果始终完整。它和较新的架构说明存在版本差异，不能据博客推导当前 Maka 的完整行为矩阵。
- 博客没有明确定义占位符字节数／哈希的编码对象；上述判断以同版本源码实现为准。它也没有要求占位符直接哈希原始 RuntimeEvent JSON。
- 本研究没有对 Maka 程序运行实测；当前实现判断来自官方仓库文档与源码。
