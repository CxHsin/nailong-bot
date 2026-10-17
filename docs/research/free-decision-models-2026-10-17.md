# 可免费使用的 Jev 同类决策模型

核对日期：2026-10-17。仅查一手公开文档，没有注册、使用密钥或实际推理。本次不重查已经试过的 Cloudflare。

## 建议

**优先注册 [Nace.AI Drex](https://console.nace.ai)**：符合资格的新用户一次赠 $25，之后每月有 $5，属于持续补充的免费额度。**[Bespoke Nimble](https://console.bespokelabs.ai)** 邮箱验证赠 $1，适合额外对照，但属于一次赠金，文档没有承诺每月补充。

免费额度不等于无限免费；能下载权重也不等于提供免费托管 API。以下分别列明。

## 托管 API 免费额度

| 产品 | 免费内容 | 条件与期限 | 官方来源 |
| --- | --- | --- | --- |
| Drex | 新客 $25；之后每月 $5 | Google 登录、注册至少 30 天的 GitHub 账号登录、或验证非预付支付卡三选一；只用邮箱验证码不自动满足。新客赠金 3 个月过期；月赠首次在注册一个月后发放，下一次更新时过期，不累计 | [价格](https://console.nace.ai/docs/drex/reference/pricing)、[入门](https://console.nace.ai/docs/drex/quickstart) |
| Nimble | 邮箱验证一次赠 $1 | 每个邮箱一次，邮箱变体不重复赠；归组织使用。文档没有承诺月赠 | [价格](https://docs.bespokelabs.ai/nimble/pricing) |

Drex `drex-v2.0` 是 $0.06/百万输入 tokens，输出不收费，所以月赠 $5 对应约 8,333 万个计费输入 tokens；这是按单价计算的数量，不是固定多少次请求。费用以响应的 `usage.input_tokens` 为准。注册可以选择 Google 或符合年龄的 GitHub 账号获得额度，因而不必为免费额度绑定支付卡。文档说卡验证本身不收费且不打开 pay as you go，但另行保存支付卡并启用自动付款会导致超额度计费；只想使用免费额度时应保持自动付款关闭。[官方价格](https://console.nace.ai/docs/drex/reference/pricing)

Nimble `nimble-v4` 是 $0.04/百万输入 tokens，输出免费，$1 相当于 2,500 万个计费输入 tokens。文档还提供推荐新用户的奖励，但那是额外条件，不能当作每月自动免费额度；不建议为了评测组织这类活动。[官方价格](https://docs.bespokelabs.ai/nimble/pricing)

## 开放权重：可以自己运行，算力另计

### AutoJev-27B

- 作者发布的 [模型卡](https://huggingface.co/denis-pplx/autojev-27b)明确：权重 Apache 2.0，代码 MIT；基于 Qwen3.8-27B，返回给定选项的概率，提供 TypeSafe 兼容的 `/v1/systemone`，支持 choice/noul/score。
- [作者代码仓库](https://github.com/denis-pplx/autojev)给出下载和本地服务命令，要求 Python 3.12+、uv，以及能容纳约 **49 GiB BF16 权重加运行开销**的 GPU。
- 模型卡仍保留“while the weights are private”旧句，但本次 [Hugging Face 模型元数据](https://huggingface.co/api/models/denis-pplx/autojev-27b)返回 `private:false`、`gated:false`，license 为 Apache 2.0。因此公开访问状态与旧句不一致，应以实际下载状态核对；本次没有下载大权重。
- 模型页明确没有 Inference Provider 部署。公开权重和代码允许自部署，不代表有作者承诺的免费云 API。租 GPU、电费和部署成本仍由使用者承担。

### SimpleJev / JevAny

- [作者仓库](https://github.com/SimpleJev/JevAny)是 System 1 决策模型训练与部署基础设施，代码和 starter data 使用 Apache 2.0，提供本地服务及发布的 LoRA 检查点。
- [JevAny Qwen3.5 4B Direct-Token LoRA 模型卡](https://huggingface.co/SimpleJev/JevAny-Qwen3.5-4B-Direct-Token-LoRA)说明只包含适配器和读出元数据，**不包含基座权重**，基座许可与访问条件仍适用。不能把代码 Apache 2.0 泛化成所有基座和适配器均无条件可用。
- 仓库给出的 Qwen 4B 方案需要约 **8 GB BF16 基座权重再加运行内存**；27B 约 54 GB 再加运行开销。0.8B CPU starter 推荐 16 GB RAM，但需要先在附带示例数据上训练小适配器，并非现成同等能力的免费 API。
- 因此它适合已有本地硬件、愿意部署的路线。模型页没有托管 Inference Provider；不能称为注册后就能用的免费在线服务。[作者仓库](https://github.com/SimpleJev/JevAny)、[模型卡](https://huggingface.co/SimpleJev/JevAny-Qwen3.5-4B-Direct-Token-LoRA)

## 对本项目的选择

要继续中文上下文分类评测，先用 Drex 的免费额度和 Nimble 一次赠金即可形成两个直接同类对照。开放权重路线可以随后考虑，当前不需要为了拿免费额度先部署 27B 模型。上述免费规则是一手文档在核对日的状态；中文路由准确率和实际网络延迟尚未由本次研究实测。
