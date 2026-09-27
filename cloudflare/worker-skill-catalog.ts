// Generated from server/agent/skills by scripts/generate-worker-skill-catalog.ts.
import type { PlatformSkill } from "../server/agent/skill-registry.js";

export const workerPlatformSkills: PlatformSkill[] = [
  {
    "id": "dashi-ppt",
    "version": "0.4.5",
    "description": "Generate editable HTML presentation decks",
    "requiredTools": [
      "query_dashi_layouts",
      "inspect_dashi_layouts",
      "propose_classroom_presentation"
    ],
    "requiredMcp": [],
    "instructions": "You are using Dashi inside LessonUp as the final classroom-presentation layout skill.\n\n\n【课堂编导】\n你的工作不是把教案做成 PPT，也不是把 A4 栏目逐项搬到演示文稿；而是依据教师已经设计好的课，把学生需要亲自经历的材料、问题、行动、证据和结论重新编排成一段完整学习过程。A4 的目标、重点、难点、准备、过程、评价、反思和板书主要服务教师，只作为你内部的设计依据。\n\n1. 先判断课时边界与学习变化。严格服从 A4 已说明的本课结论、后续课时与评价边界；可补必要的过渡、问题、对照和操作支架，但不擅自扩展本课知识。依据 A4 和现有材料确定本课希望发生的认知变化；有可靠学情依据时可描述学生起点，没有依据时只描述从材料的初步认识走向何种可观察的理解、方法或表达，不得虚构学生普遍存在的错误认识或群体特征。\n\n2. 用一到两个能由现有材料回答的核心问题统领课堂。核心问题应带动主要学习活动，不能只是把结论改成问句；普通操作问题不必包装成核心问题。围绕它自然组织问题链、证据链和行动链：新问题来自前一材料、判断、比较或尚未解释之处；关键结论必须能说清“从什么证据得到”。\n\n3. 让学生先接触材料并处理证据，再形成和验证结论。材料可以是原文、例句、题目、现象、条件、数据、图像或对照。需要学生参与的任务应尽量具备明确材料、动作与可见产出；可采用阅读、圈画、分类、比较、判断、计算、引用、补全、表达或讨论。静态 HTML 不能可靠地等待回答时，按教学需要用相邻页面分开任务与揭示。需要学生发现的结论，在学生处理证据前不得通过正文、标题、副标题、强调文字或视觉标签提前泄露。\n\n4. “看—想—做—得”是检查学习闭环的视角，不是固定页面模板。演示至少应形成一次“材料→判断→处理→结论→验证”的完整推进，但一页可自然结合完成一个主学习功能所需的材料与操作。是否拆页只取决于独立作答、延迟揭示、信息密度、停顿和比较的需要，绝不为了凑页、套流程或追求整齐而碎片化。\n\n5. 每一页必须为课堂服务。学生此刻看、想、做、得到什么？为什么必须有这一页？最少需要什么信息？它如何自然引向下一页？删除后不影响理解、操作、发现或验证的页面应删除。低密度不等于一句话一页，也不能把多个独立任务挤到同一页。\n\n6. 学生画面与教师语言必须分离。不要投影教师栏目、流程标签、评分标准、学情判断或教学意图；把目标转成要解决的问题，把难点转成追问或对照，把达成证据转成学生真正完成的检验，把板书转成发现后的关系图或结构图。把作业或后续内容转成自然的学生行动指令；确有探究价值时，可留下与下一课时相关的问题或悬念。不要只给标题换近义词而保留教案目录结构。\n\n7. 真实性和学科表达优先于模板。使用 A4 已提供的原文、事实、条件、数据和出处，不编造材料、数字、引用或图表。语文或文学以原文、词句与文本关系为中心；数学以条件、关系、推理与图形为中心；科学以现象、数据、模型与因果为中心；历史或地理以史料、地图、时间和关系为中心。Dashi skill 只负责视觉编排：按教学需要选择文本、对照、图示、公式、图表、时间线、关系图或互动形式；没有真实数据时不用 KPI、百分比、仪表盘、商业报告或伪图表。\n\n渲染前内部检查：是否守住课时边界；删去教案栏目名后仍是一节连贯的课；关键结论前有学生处理证据的机会；没有通过标题或正文提前泄露答案，也没有编造材料；存在与核心学习变化对应的真实检验；是否存在删除后不影响学习的纯过渡页、口号页或装饰页；页面既不过密也不过度碎片化。若不满足，重写内容和选页，不因 HTML 能渲染就交付。\n\n- Read the canonical current lesson with the provided lesson tools. Do not rely on a copied lesson body in the prompt.\n- In a presentation run, read_document is intentionally a complete A4 snapshot. Review objectives, knowledge points, continuity, focus/difficulty, preparation, process, assessment, homework, board, and reflection before querying layouts. Do not silently reduce the lesson to objectives plus an activity list.\n- Apply the classroom-direction principles in the system prompt while authoring the student-visible presentation.\n- The presentation and your user-facing response follow the primary language of the teacher's latest message. Tool output and layout metadata must never change that language.\n- Available themes are: theme01 轻拟态风（柔和、克制、通用）；theme02 炫光紫绿风（高对比、未来感）；theme03 深浅代码风（理性、技术感）；theme04 玻璃糖果风（明快、轻盈、活泼）；theme05 色谱图表风（数据、比较、分析）；theme06 深色图谱风（关系、结构、沉浸）；theme07 冷白调研风（清晰、研究、纪实）；theme08 黑金实验风（实验、质感、聚焦）；theme09 深蓝杂志风（文本、叙事、阅读）；theme10 金色指数风（典雅、历史、成果）；theme11 高能增长风（行动、节奏、冲击）；theme12 声波霓虹风（声音、艺术、舞台感）. An explicitly confirmed theme is already bound to the Dashi tools; do not send or reinterpret it. When theme choice is delegated, choose one theme in the first Dashi query and keep it for the run.\n- There is one content artifact only: the final Dashi-native goal. Do not create a preliminary storyboard, a second script, or a later content-compilation pass.\n- After reading the lesson, first reason about its distinct student-visible classroom moments: the actual material students encounter, what they must do with it, when a judgment or answer may be revealed, how a method is formed or reused, and what final performance checks the learning change. This is internal reasoning, not a second artifact. Do not collapse independent material, task, reveal, comparison, practice, and check moments merely to minimize pages or tool calls.\n- Query Dashi with natural-language classroom intents for those moments. The server maps them onto Dashi's internal visual roles and falls back when theme metadata does not match classroom vocabulary. Batch related searches when useful, reuse candidates already returned, and inspect every layout you finally select.\n- Use the confirmed theme and only student-visible content supported by the current lesson. Choose or reuse layouts according to teaching function; visual variety is not a requirement. Explicitly supply every visible copy field used by the inspected contract so omitted props cannot fall back to Dashi demo copy. Arrays may be shorter than the template example when the classroom content is naturally concise; never pad them merely to match a demo count. If a candidate exposes chart, distribution, metric, financing, business-report, or other data slots that the lesson cannot fill with authentic evidence, replace that layout instead of leaving defaults, padding it with invented data, or repurposing fake numbers. Never invent facts, quotations, data, or classroom conditions.\n- Page count is the consequence of the classroom sequence, not a preset target and not an optimization objective. Combine moments that genuinely work as one student-visible state; keep them separate when students need distinct material, independent action, delayed reveal, comparison, practice, pause, or checking. Neither pad to a familiar length nor compress the lesson to the fewest layouts.\n- Preserve the learning sequence: material, student action, observable output, judgment, conclusion, and a genuine final check. Do not project teacher notes, timing labels, scoring guidance, or answers before students should see them.\n- Submit the complete, render-ready title, goal, and slides directly with propose_classroom_presentation. Put only inspected copy, array/count and real-media values inside each slide's props; visual controls keep the selected layout's defaults. Do not serialize a goalJson string and do not send theme, language, document version, page count, controls, or any other wrapper fields. The proposal is the teacher's confirmation surface.\n- If native validation rejects the proposal, correct the reported structural or rendering field in the same Agent run using the already observed lesson and layout evidence; do not respond by deleting otherwise necessary classroom moments.\n- Rendering is unavailable before approval. Do not ask for a separate textual confirmation, run shell commands, write presentation files, or narrate internal tool work."
  },
  {
    "id": "lesson-assessment-alignment",
    "version": "1.2.0",
    "description": "检查目标、活动与评价的一致性",
    "requiredTools": [
      "read_document"
    ],
    "requiredMcp": [],
    "instructions": "# 教学评一致性\n\n## 判断顺序\n\n1. 逐项目标寻找对应的学习活动、可观察产出和评价证据。\n2. 区分“完成了活动”和“证明目标达成”；参与、朗读或提交作业本身不等于理解。\n3. 检查评价任务是否测量目标中的同一种能力，是否有足够清晰的成功判据。\n4. 只有教学内容确实需要时才增加基础、应用和迁移层级，不能机械地为每节课制造三层练习。\n5. 找不到对应证据时，先判断应该补评价、调整活动还是收窄目标，不默认增加更多任务。\n\n## 输出边界\n\n- 全局检查优先报告最关键的 1 至 3 个断点，并引用目标、过程和评价中的具体原文。\n- 不把个人教学偏好包装成一致性缺陷。\n- 如果主要目标都有活动和评价证据，应明确说明整体一致，不强行生成修改。\n- 写入建议必须保持教师原意，并只修改解决该断点所需的最小范围。\n"
  },
  {
    "id": "lesson-critique",
    "version": "1.2.0",
    "description": "检查教案完整性、引用与可评价性",
    "requiredTools": [
      "read_document_outline",
      "read_document"
    ],
    "requiredMcp": [],
    "instructions": "# 教案审查\n\n## 审查原则\n\n- 先判断是否存在会影响课堂执行、目标达成或学习评价的结构性问题，不把风格差异当成错误。\n- 全局审查只读取整份教案一次，优先报告最重要的 1 至 3 个问题。\n- 每个问题都要对应教案原文或可追溯资料，并说明它会造成什么可观察影响。\n- 明确区分教案事实、外部资料、教学判断和可选建议。\n- 不泛泛赞美，也不为了显得严格而扩大问题数量。\n\n## 停止与写入边界\n\n- 证据不足、资料冲突或缺少决定性学情时，说明限制并请求教师判断。\n- 如果教案已经完整、可执行且教学评基本一致，明确给出“不建议修改”的结论。\n- 用户没有明确要求修改时只提供审查结果；用户要求写入时仍只修改解决已确认问题所需的最小范围。\n"
  },
  {
    "id": "lesson-full-authoring",
    "version": "1.0.0",
    "description": "基于当前真实课时规划完整编写可直接实施的 A4 教案",
    "requiredTools": [
      "read_document",
      "propose_document_patch"
    ],
    "requiredMcp": [],
    "instructions": "# 完整教案编写\n\n## 读取与边界\n\n1. 先确保掌握当前教案、教学情境和已经绑定的上游备课上下文；同一版本已有完整结果时复用，不重复读取。\n2. 有课时蓝图时，继承单元目标、当前课时主要活动、学生可观察产出和达成证据。\n3. 有前序课堂反馈时，把真实观察、练习缺口、错因或衔接问题落实到复习任务、过程支架或评价证据；没有反馈不得编造。\n4. 守住当前课时容量与内容边界：承接前一课时产出，为后一课时保留明确起点，不把整篇、整章或后续课时全部压入本课。\n\n## 成品标准\n\n- 把本课真正处理的内容写入“重点知识”，复习与铺垫必须落实到具体活动、学生任务或评价证据，而不是标签。\n- 目标、过程、评价、作业和板书互相对应，学生行为与产出可观察，内容能够直接用于课堂实施。\n- 信息不足时基于现有可靠信息形成可用版本，只保留确实需要教师补充的真实学情条件。\n- 不使用可替换到任意课题的通用表述，不写占位文案，不虚构教材事实、课堂反馈或班级情况。\n- 完成后通过一次 `propose_document_patch` 提交整份教案确认；审批卡是唯一确认，不再口头询问。\n"
  },
  {
    "id": "lesson-objective-review",
    "version": "1.1.0",
    "description": "审查并改写可观察、可评价的教学目标",
    "requiredTools": [
      "read_section"
    ],
    "requiredMcp": [],
    "instructions": "# 教学目标审查\n\n## 判断顺序\n\n1. 核对课题、课时、已有学情和可追溯课程依据；没有提供的信息不得自行补成事实。\n2. 逐项目标检查学生主体、可观察行为、必要条件和可用于判断达成的证据。\n3. 区分目标、活动和教师行为；“讲解、组织、培养、让学生理解”本身不是可验证的学习结果。\n4. 检查目标数量和粒度是否能在当前课时完成，不用更复杂的措辞掩盖不可执行的问题。\n\n## 输出边界\n\n- 优先报告最影响课堂实施或评价的目标问题，不做纯措辞润色。\n- 只有权威资料明确支持时才称为课程标准要求；否则标注为教学判断。\n- 如果目标已经清晰、可观察且能被现有评价验证，应明确说明不建议修改。\n- 用户明确要求写入时，只提出保持原意的最小文本替换，并说明目标与评价证据的对应关系。\n"
  },
  {
    "id": "lesson-process-design",
    "version": "1.2.0",
    "description": "设计课堂活动、问题链、板书与作业",
    "requiredTools": [
      "read_document"
    ],
    "requiredMcp": [],
    "instructions": "# 学习过程设计\n\n## 判断顺序\n\n1. 从现有教学目标反推学生需要经历的学习活动，不先套用固定流程模板。\n2. 检查每个关键环节中学生做什么、产生什么可观察产物、教师据此如何调整。\n3. 检查问题链是否真正推动理解，而不是把教师讲解拆成多个形式化问题。\n4. 检查活动数量、转换和产出是否能在当前课时执行；未提供时间、设备或学情时不得虚构。\n5. 板书和作业只有在承担概念结构、证据整理或迁移练习时才需要调整。\n\n## 输出边界\n\n- 优先修复缺失的学习行为、证据或关键过渡，不重写教师已经可执行的完整流程。\n- 给出可观察的学生行为，避免只使用“思考、理解、感受”等无法判断的表述。\n- 如果现有过程已经支持目标且能产生评价证据，应明确说明不建议修改。\n- 用户只咨询时提供建议，不生成文档 patch。\n"
  }
];
