/* ============================================================
   core.js · 产品页与评测页共享的唯一真相源
   - 6 个节点的 prompt 全文（与 PROMPTS.md 逐字同步）
   - 所有 JSON schema、输出校验函数、callLLM、本地强校验
   - 修改 prompt 只需改这里；两个页面通过 <script src="core.js"> 共用
   ============================================================ */
  const KEY_API = 'deepseek_api_key';
  const KEY_JD = 'jd_analysis';
  const JD_SCHEMA = {
    type:'object', additionalProperties:false,
    properties:{
      position_name:{type:'string'},
      responsibilities:{type:'array',items:{type:'string'}},
      core_requirements:{type:'array',items:{type:'object',additionalProperties:false,properties:{ability:{type:'string'},text:{type:'string'},priority:{type:'string'}},required:['ability','text','priority']}},
      must_haves:{type:'array',items:{type:'string'}}, nice_to_haves:{type:'array',items:{type:'string'}},
      tech_skills:{type:'array',items:{type:'string'}}, business_skills:{type:'array',items:{type:'string'}}
    }, required:['position_name','responsibilities','core_requirements','must_haves','nice_to_haves','tech_skills','business_skills']
  };
  const EXP_SCHEMA = {
    type:'object', additionalProperties:false,
    properties:{
      project_name:{type:'string'}, project_background:{type:'string'}, user_problem:{type:'string'},
      responsibilities:{type:'string'}, actions:{type:'string'}, results:{type:'string'},
      skills:{type:'array',items:{type:'object',additionalProperties:false,
        properties:{label:{type:'string'},evidence:{type:'string'},status:{type:'string'}},
        required:['label','evidence','status']}},
      unresolved_fields:{type:'array',items:{type:'string'}}
    },
    required:['project_name','project_background','user_problem','responsibilities',
      'actions','results','skills','unresolved_fields']
  };
  // PROMPTS.md 节点 1 · V1 全文（唯一真相源；修改请改 PROMPTS.md 后同步此处）
  const PROMPT_EXTRACT = `你是求职经历信息抽取助手。把用户提供的项目/实习经历原文转成结构化数据，并抽取能力标签。

输入：用户填写的项目/实习经历原文（可能包含模糊表述或不完整信息）。

输出：只输出一个 JSON 对象，不要任何解释文字或 Markdown 代码块标记：
{
  "project_name": "项目名称",
  "project_background": "项目背景",
  "user_problem": "解决的问题",
  "responsibilities": "个人职责，保留原文的职责强度词（参与/负责/主导）",
  "actions": "具体行动",
  "results": "项目结果；原文未提供则输出空字符串",
  "skills": [
    {"label": "能力标签名称", "evidence": "支撑该标签的原文片段", "status": "待确认"}
  ],
  "unresolved_fields": ["原文信息不足、无法确定的字段名"]
}

强约束：
1. 每个字段只能从原文抽取，不得编造、推测或补充原文不存在的信息。
2. 每个能力标签必须附 evidence，且 evidence 必须是输入原文中真实存在的连续片段，不得改写或拼接；无法提供原文依据的标签不要输出。
3. 禁止输出原文未体现的能力；禁止把"用户增长""战略思维"等泛化词当作硬技能标签。
4. results 原文未提供时必须输出空字符串，并字段名写入 unresolved_fields，严禁编造量化数据。
5. skills 中每项 status 固定为"待确认"，不得输出"已确认"。
6. 职责强度词必须原样保留："参与"不得写成"主导"，"协助"不得写成"独立负责"。`;

  const MATCH_SCHEMA = {
    type:'object', additionalProperties:false,
    properties:{
      matches:{type:'array',items:{type:'object',additionalProperties:false,properties:{
        ability:{type:'string'},experience:{type:'string'},evidence:{type:'string'},
        match_status:{type:'string'},reasoning:{type:'string'}},
        required:['ability','experience','evidence','match_status','reasoning']}},
      missing_abilities:{type:'array',items:{type:'string'}}
    }, required:['matches','missing_abilities']
  };
  const GAP_SCHEMA = {
    type:'object', additionalProperties:false,
    properties:{
      gaps:{type:'array',items:{type:'object',additionalProperties:false,properties:{
        ability:{type:'string'},gap_type:{type:'string'},question:{type:'string'}},
        required:['ability','gap_type','question']}}
    }, required:['gaps']
  };
  // PROMPTS.md 节点 3 · V1 全文
  const PROMPT_MATCH = `你是岗位能力匹配助手。判断用户的已确认经历能否证明 JD 的每项能力要求。

输入：JD 能力画像 + 用户已确认的经历列表。

输出：只输出一个 JSON 对象：
{
  "matches": [
    {
      "ability": "JD 能力要求",
      "experience": "匹配到的项目名称，无则输出空字符串",
      "evidence": "来自经历原文的证据片段",
      "match_status": "有直接证据|待确认|暂无证据",
      "reasoning": "判断理由"
    }
  ],
  "missing_abilities": ["暂无证据的能力要求"]
}

强约束：
1. 每条结论必须给出 evidence，且 evidence 必须是经历原文中真实存在的连续片段；找不到原文依据时，match_status 必须为"暂无证据"，evidence 输出空字符串。
2. 禁止仅凭关键词相似判定匹配；必须判断经历内容是否真正体现该能力。
3. 禁止把"待确认"自动升级为"有直接证据"。
4. 只能使用 confirmation_status 为"已确认"的经历与标签，待确认内容不得作为证据。
5. 每项 ability 只能对应一个 match_status，不得模棱两可。`;
  // PROMPTS.md 节点 4 · V1 全文
  const PROMPT_GAP = `你是能力缺口分析助手。根据匹配结果，指出用户缺失或证据不足的能力。

输入：JD 能力画像 + 节点 3 的匹配结果。

输出：只输出一个 JSON 对象：
{
  "gaps": [
    {
      "ability": "缺失或证据不足的能力",
      "gap_type": "暂无证据|待确认",
      "question": "针对该缺口的具体补充提问"
    }
  ]
}

强约束：
1. 只针对 match_status 为"暂无证据"或"待确认"的能力生成缺口，不得对"有直接证据"的能力提问。
2. question 必须具体到用户能直接回答，例如"你参与 AI 音乐生成模块时是否做过效果评测？请描述评测方法"，禁止笼统地问"请补充相关经验"。
3. 每条缺口只问一类信息，不要在一个问题里塞多个能力。
4. missing_abilities 中的每个能力都必须出现在 gaps 中，不得遗漏。`;

  /* ---------- 阶段 3：简历生成 + 事实校验（节点 5 + 节点 6） ---------- */
  const RESUME_SCHEMA = {
    type:'object', additionalProperties:false,
    properties:{
      summary:{type:'string'},
      projects:{type:'array',items:{type:'object',additionalProperties:false,properties:{
        project_name:{type:'string'},background:{type:'string'},responsibilities:{type:'string'},
        actions:{type:'string'},results:{type:'string'}},
        required:['project_name','background','responsibilities','actions','results']}},
      skills:{type:'array',items:{type:'string'}}
    }, required:['summary','projects','skills']
  };
  const VALIDATE_SCHEMA = {
    type:'object', additionalProperties:false,
    properties:{
      risk_level:{type:'string'},
      risk_items:{type:'array',items:{type:'object',additionalProperties:false,properties:{
        content:{type:'string'},risk_type:{type:'string'},level:{type:'string'},
        original_evidence:{type:'string'},suggestion:{type:'string'}},
        required:['content','risk_type','level','original_evidence','suggestion']}}
    }, required:['risk_level','risk_items']
  };
  // PROMPTS.md 节点 5 · V1 全文（唯一真相源）
  const PROMPT_RESUME = `你是岗位定向简历生成助手。基于用户已确认的经历和 JD 能力画像，生成针对性简历。

输入：JD 能力画像 + 用户已确认的经历 + 匹配结果。

输出：只输出一个 JSON 对象：
{
  "summary": "与岗位相关的个人概述，仅使用已确认信息",
  "projects": [
    {
      "project_name": "与原始经历完全一致",
      "background": "项目背景",
      "responsibilities": "个人职责，保留原职责强度",
      "actions": "具体行动",
      "results": "仅使用原文提供的结果"
    }
  ],
  "skills": ["只使用已确认的能力标签"]
}

强约束：
1. 只能使用已确认的经历、标签和信息，禁止使用任何待确认内容。
2. 不得编造项目背景、个人职责、量化数据或成果；原文没有的结果留空。
3. 不得把"参与"写成"主导"、"协助"写成"独立负责"，职责强度词与原文保持一致。
4. 项目名称必须与原文完全一致。
5. 根据匹配结果调整项目顺序，把有直接证据的项目排在前面。
6. 不得为了贴合 JD 而新增原文不存在的能力标签。`;
  // PROMPTS.md 节点 6 · V1 全文
  const PROMPT_VALIDATE = `你是简历事实校验助手。对照用户原始经历，检查生成简历是否存在事实越界。

输入：用户原始经历（含原文与标签）+ 生成的简历。

输出：只输出一个 JSON 对象：
{
  "risk_level": "高|中|低",
  "risk_items": [
    {
      "content": "存在风险的表述",
      "risk_type": "职责夸大|虚构数据|项目名不一致|新增未提供内容|待确认写成事实",
      "level": "高|中|低",
      "original_evidence": "对应的原始经历片段，无则输出空字符串",
      "suggestion": "修改建议"
    }
  ]
}

强约束：
1. 逐项对照原文检查：项目名一致性、职责一致性、是否新增未提供内容、是否虚构数据、职责强度是否被夸大、待确认是否被写成事实。
2. 风险分级：高=明确与原文冲突或凭空编造；中=缺少原文依据但无明显冲突；低=仅表达优化。
3. 每项风险必须给出 original_evidence；找不到时输出空字符串，不得编造证据。
4. 只标注风险，不得直接改写简历内容，修改建议写进 suggestion。
5. 不得因为表述好看而降低风险等级。
6. 你的判断不能保证绝对正确，最终以用户人工审核为准。`;

  const MATCH_STATUS = ['有直接证据','待确认','暂无证据'];
  const RISK_LEVELS = ['高','中','低'];


  const PROMPT_JD = '你是严谨的 JD 解析助手。只提取原文明确表达的信息，不得凭空增加 JD 中不存在的硬性要求，不得把推断写成事实。不确定的核心要求必须将 priority 标记为“待确认”。core_requirements 每项包含 ability、text、priority；priority 使用“必须”“优先”或“待确认”。所有列表字段在无内容时返回空数组，position_name 不明确时返回空字符串。应用会在本地逐字保留完整原始 JD；不要改写或补全原文内容。只返回 JSON。';

  const storage = (function(){
    try { const k='__t'; localStorage.setItem(k,k); localStorage.removeItem(k); return localStorage; }
    catch(e){ const m={}; return { getItem:k=>m[k]??null, setItem:(k,v)=>{m[k]=String(v)}, removeItem:k=>{delete m[k]} }; }
  })();
  function lsGet(key, fallback){ try{ const v=storage.getItem(key); return v?JSON.parse(v):fallback }catch(e){ return fallback } }
  function lsSet(key, val){ storage.setItem(key, JSON.stringify(val)) }
  function esc(s){ return String(s??'').replace(/[&<>"']/g, c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c])) }
  // 兼容阶段 0 遗留的字符串标签；新数据为对象数组
  async function callLLM(messages,schema){
    const apiKey=storage.getItem(KEY_API);
    if(!apiKey) throw new Error('请先在右上角「设置」中填写 DeepSeek API Key');
    const requestMessages=[...messages];
    const schemaInstruction='输出必须符合以下 JSON 字段结构（仅作字段约束）：\n'+JSON.stringify(schema);
    if(requestMessages[0]?.role==='system') requestMessages[0]={...requestMessages[0],content:requestMessages[0].content+'\n\n'+schemaInstruction};
    else requestMessages.unshift({role:'system',content:schemaInstruction});
    const response=await fetch('https://api.deepseek.com/chat/completions',{
      method:'POST',headers:{'Content-Type':'application/json','Authorization':'Bearer '+apiKey},
      body:JSON.stringify({model:'deepseek-chat',messages:requestMessages,response_format:{type:'json_object'},stream:false})
    });
    const payload=await response.json().catch(()=>({}));
    if(!response.ok) throw new Error(payload.error?.message||('DeepSeek 请求失败（HTTP '+response.status+'）'));
    const content=payload.choices?.[0]?.message?.content;
    if(!content) throw new Error('模型没有返回内容');
    return JSON.parse(content);
  }
  function validateExtractResult(data){
    if(!data || typeof data!=='object' || Array.isArray(data)) throw new Error('输出必须是 JSON 对象');
    for(const key of EXP_SCHEMA.required) if(!(key in data)) throw new Error('缺少字段：'+key);
    for(const key of ['project_name','project_background','user_problem','responsibilities','actions','results'])
      if(typeof data[key]!=='string') throw new Error(key+' 必须是字符串');
    if(!Array.isArray(data.skills)) throw new Error('skills 必须是数组');
    if(!Array.isArray(data.unresolved_fields)) throw new Error('unresolved_fields 必须是数组');
    data.skills.forEach((s,i)=>{
      if(!s || typeof s.label!=='string' || typeof s.evidence!=='string' || typeof s.status!=='string')
        throw new Error('skills 第 '+(i+1)+' 项结构错误');
    });
    return data;
  }
  function validateJDResult(data){
    if(!data||typeof data!=='object'||Array.isArray(data)) throw new Error('输出必须是 JSON 对象');
    for(const key of JD_SCHEMA.required) if(!(key in data)) throw new Error('缺少字段：'+key);
    if(typeof data.position_name!=='string') throw new Error('position_name 必须是字符串');
    for(const key of ['responsibilities','core_requirements','must_haves','nice_to_haves','tech_skills','business_skills'])
      if(!Array.isArray(data[key])) throw new Error(key+' 必须是数组');
    data.core_requirements.forEach((item,i)=>{
      if(!item||typeof item.ability!=='string'||typeof item.text!=='string'||typeof item.priority!=='string')
        throw new Error('core_requirements 第 '+(i+1)+' 项必须含 ability、text、priority 字符串');
    });
    return data;
  }
  function validateMatchResult(data){
    if(!data||typeof data!=='object'||Array.isArray(data)) throw new Error('输出必须是 JSON 对象');
    for(const key of MATCH_SCHEMA.required) if(!(key in data)) throw new Error('缺少字段：'+key);
    if(!Array.isArray(data.matches)) throw new Error('matches 必须是数组');
    if(!Array.isArray(data.missing_abilities)) throw new Error('missing_abilities 必须是数组');
    data.matches.forEach((m,i)=>{
      for(const k of ['ability','experience','evidence','match_status','reasoning'])
        if(typeof m?.[k]!=='string') throw new Error('matches 第 '+(i+1)+' 项字段 '+k+' 必须是字符串');
      if(MATCH_STATUS.indexOf(m.match_status)===-1) throw new Error('matches 第 '+(i+1)+' 项状态非法');
    });
    return data;
  }
  function validateGapResult(data){
    if(!data||typeof data!=='object'||Array.isArray(data)) throw new Error('输出必须是 JSON 对象');
    if(!Array.isArray(data.gaps)) throw new Error('gaps 必须是数组');
    data.gaps.forEach((g,i)=>{
      for(const k of ['ability','gap_type','question'])
        if(typeof g?.[k]!=='string') throw new Error('gaps 第 '+(i+1)+' 项字段 '+k+' 必须是字符串');
      if(g.gap_type!=='暂无证据' && g.gap_type!=='待确认') throw new Error('gaps 第 '+(i+1)+' 项 gap_type 非法');
    });
    return data;
  }
  // 本地强校验：evidence 必须是某条已确认经历原文的子串；否则降级（不信任模型自律）
  function enforceEvidenceOnMatches(matches, corpus, exps){
    const corpusText = corpus.join('\n');
    const names = exps.map(e=>e.project_name);
    return matches.map(m=>{
      const out = Object.assign({}, m);
      if(out.match_status==='有直接证据'){
        if(!out.evidence || corpusText.indexOf(out.evidence)===-1){
          out.evidence=''; out.match_status='暂无证据';
          out.reasoning = (out.reasoning||'')+' [本地校验：证据非经历原文，已降级]';
        }
        // 匹配到的项目名必须存在于已确认经历
        if(out.experience && names.indexOf(out.experience)===-1){
          out.experience=''; out.evidence=''; out.match_status='暂无证据';
          out.reasoning = (out.reasoning||'')+' [本地校验：项目名不在已确认经历，已降级]';
        }
      }
      if(out.match_status==='暂无证据') out.evidence='';
      return out;
    });
  }
  function validateResumeResult(data){
    if(!data||typeof data!=='object'||Array.isArray(data)) throw new Error('输出必须是 JSON 对象');
    for(const k of RESUME_SCHEMA.required) if(!(k in data)) throw new Error('缺少字段：'+k);
    if(typeof data.summary!=='string'||!Array.isArray(data.projects)||!Array.isArray(data.skills))
      throw new Error('summary/projects/skills 类型错误');
    data.projects.forEach((p,i)=>{
      for(const k of ['project_name','background','responsibilities','actions','results'])
        if(typeof p?.[k]!=='string') throw new Error('projects 第 '+(i+1)+' 项字段 '+k+' 必须是字符串');
    });
    if(data.skills.some(s=>typeof s!=='string')) throw new Error('skills 必须是字符串数组');
    return data;
  }
  function validateValidateResult(data){
    if(!data||typeof data!=='object'||Array.isArray(data)) throw new Error('输出必须是 JSON 对象');
    for(const k of VALIDATE_SCHEMA.required) if(!(k in data)) throw new Error('缺少字段：'+k);
    if(RISK_LEVELS.indexOf(data.risk_level)===-1) throw new Error('risk_level 非法');
    if(!Array.isArray(data.risk_items)) throw new Error('risk_items 必须是数组');
    data.risk_items.forEach((r,i)=>{
      for(const k of ['content','risk_type','level','original_evidence','suggestion'])
        if(typeof r?.[k]!=='string') throw new Error('risk_items 第 '+(i+1)+' 项字段 '+k+' 必须是字符串');
      if(RISK_LEVELS.indexOf(r.level)===-1) throw new Error('risk_items 第 '+(i+1)+' 项 level 非法');
    });
    return data;
  }
  // 本地事实强校验：不信任模型自律，按硬规则复查（可直接对编辑后的简历重跑）
  // 返回风险数组，字段与节点 6 一致，另加 source:'本地'
  function localFactCheck(resume, src){
    const risks = [];
    const push = (content,risk_type,level,original_evidence,suggestion)=>
      risks.push({content,risk_type,level,original_evidence,suggestion,source:'本地'});
    const hasNum = s => /\d+(?:\.\d+)?\s*(?:%|％|倍|万|千|元|分|个点|人次|人|个)/.test(s||'');
    // 强度词夸大检测：原文"参与/协助"与生成"主导/独立负责"冲突
    const strong = /(主导|独立负责|牵头|负责整个|从\s*0\s*到\s*1|全权)/;
    const weak = /(参与|协助|配合)/;
    resume.projects.forEach(p=>{
      const s = src.byName[p.project_name];
      if(!s){
        push('项目「'+p.project_name+'」不在已确认经历中','项目名不一致','高','',
          '删除该项目，或先到经历库补录并确认这段经历');
        return;
      }
      const genText = [p.responsibilities,p.actions].filter(Boolean).join('；');
      if(weak.test(s.fields.responsibilities||'') && strong.test(genText))
        push('「'+p.project_name+'」职责被写成强主导（'+p.responsibilities.slice(0,40)+'）',
          '职责夸大','高',s.fields.responsibilities||s.fields.raw_text.slice(0,80),
          '改回原文强度，如「参与」「协助」，不要把参与写成主导');
      const srcResults = s.fields.results||'';
      if(!srcResults && p.results)
        push('「'+p.project_name+'」原文无结果，简历却写了结果（'+p.results.slice(0,40)+'）',
          '新增未提供内容','高','', '结果字段留空；如需写成果，先补充真实结果并确认');
      if(p.results && hasNum(p.results)){
        const srcNums = (s.fields.raw_text||'').match(/\d+(?:\.\d+)?/g)||[];
        const genNums = p.results.match(/\d+(?:\.\d+)?/g)||[];
        const invented = genNums.filter(n=>srcNums.indexOf(n)===-1);
        if(invented.length)
          push('「'+p.project_name+'」结果含原文没有的数字：'+invented.join('、'),
            '虚构数据','高',srcResults||s.fields.raw_text.slice(0,80),
            '删除或改回原文真实数据，不要编造量化成果');
      }
    });
    // 能力标签：只能是已确认标签
    (resume.skills||[]).forEach(sk=>{
      const label = String(sk).trim();
      if(label && !src.confirmedSkillSet.has(label))
        push('能力标签「'+label+'」不是已确认标签','待确认写成事实','高','',
          '删除该标签，或先到经历库确认包含该能力的标签');
    });
    // 概述里出现带单位数字但所有已确认原文都没有该数字
    if(hasNum(resume.summary)){
      const genNums = (resume.summary||'').match(/\d+(?:\.\d+)?/g)||[];
      const srcNums = (src.allRaw||'').match(/\d+(?:\.\d+)?/g)||[];
      const invented = genNums.filter(n=>srcNums.indexOf(n)===-1);
      if(invented.length) push('个人概述含原文没有的数字：'+invented.join('、'),
        '虚构数据','高','', '概述中删除这些数字，只保留可追溯的信息');
    }
    return risks;
  }
  // 按匹配结果排序项目：有直接证据的在前（本地兜底，不只靠模型遵守）
  function sortProjectsByMatch(projects, matchRecord){
    if(!matchRecord||!Array.isArray(matchRecord.matches)) return projects;
    const rank = {};
    matchRecord.matches.forEach(m=>{ rank[m.experience] = m.match_status==='有直接证据'?0:m.match_status==='待确认'?1:2 });
    return projects.slice().sort((a,b)=>(rank[a.project_name]??1)-(rank[b.project_name]??1));
  }


  /* ============================================================
     V3 · 事实层 / 表达层分离（2026-11-25）
     V1 常量与函数全部保留，评测历史可复现；V3 只被产品页使用。
     事实层：事实点必须能映射回已确认经历原文（不是整句逐字复述）
     表达层：允许按 JD 措辞改写，但数字 / 职责强度词锁定
     匹配状态：有直接证据 / 可迁移 / 暂无证据
     缺口：追问卡 → 用户回答 → 写回经历库（经历库可生长）
     ============================================================ */
  const MATCH_STATUS_V3 = ['有直接证据','可迁移','暂无证据'];
  const MATCH_V3_SCHEMA = {
    type:'object',additionalProperties:false,
    properties:{
      matches:{type:'array',items:{type:'object',additionalProperties:false,properties:{
        ability:{type:'string'},experience:{type:'string'},evidence:{type:'string'},
        match_status:{type:'string'},reasoning:{type:'string'},
        transfer_fact:{type:'string'},transfer_phrase:{type:'string'}},
        required:['ability','experience','evidence','match_status','reasoning','transfer_fact','transfer_phrase']}},
      missing_abilities:{type:'array',items:{type:'string'}}
    },required:['matches','missing_abilities']
  };
  // PROMPTS.md 节点 3 · V3 全文
  const PROMPT_MATCH_V3 = `你是岗位能力匹配助手。判断已确认经历能否证明 JD 的每项能力要求，并区分「直接命中」与「可迁移」。

输入：JD 能力画像 + 用户已确认的经历列表。

输出：只输出一个 JSON 对象：
{
  "matches": [
    {
      "ability": "JD 能力要求",
      "experience": "命中的项目名，无则空字符串",
      "evidence": "【仅直接命中】来自经历原文的连续片段；其余情况必须为空字符串",
      "match_status": "有直接证据|可迁移|暂无证据",
      "reasoning": "判断理由",
      "transfer_fact": "【仅可迁移】经历里相关的事实点，必须是原文连续片段；其余情况为空字符串",
      "transfer_phrase": "【仅可迁移】把该事实点按 JD 措辞改写的简历表达候选，不得新增事实、数字，不得提升职责强度；其余情况为空字符串"
    }
  ],
  "missing_abilities": ["暂无证据的能力要求"]
}

三档定义：
- 有直接证据：经历原文直接体现该能力，evidence 为原文连续片段。
- 可迁移：经历里有相关事实，但原文没有用 JD 的说法表述（例：原文写「访谈了 12 位用户」，JD 要求「用户研究」）。此时 transfer_fact 填原文事实片段，transfer_phrase 给出按 JD 措辞的改写候选，交给用户确认。
- 暂无证据：经历库里找不到任何相关事实，四个文本字段全部为空。

强约束：
1. evidence 与 transfer_fact 必须是经历原文中真实存在的连续片段，不得改写或拼接；找不到原文依据就判「暂无证据」。
2. 禁止仅凭关键词相似判「有直接证据」；原文提到相关事实但没用 JD 术语时判「可迁移」。
3. transfer_phrase 只能换说法：不得出现原文没有的数字，不得把「参与/协助」写成「主导/独立负责/牵头」。
4. 只能使用 confirmation_status 为「已确认」的经历与标签，待确认内容不得作为证据。
5. 每项 ability 只输出一行，状态必须是三档之一。`;

  const GAP_V3_SCHEMA = {
    type:'object',additionalProperties:false,
    properties:{gaps:{type:'array',items:{type:'object',additionalProperties:false,properties:{
      ability:{type:'string'},gap_type:{type:'string'},question:{type:'string'},target_project:{type:'string'}},
      required:['ability','gap_type','question','target_project']}}},
    required:['gaps']
  };
  // PROMPTS.md 节点 4 · V3 全文
  const PROMPT_GAP_V3 = `你是经历补完助手。根据匹配结果生成「追问卡」，让用户用一句话就能补上缺失事实。

输入：JD 能力画像 + 节点 3 的匹配结果。

输出：只输出一个 JSON 对象：
{
  "gaps": [
    {
      "ability": "待补完的能力",
      "gap_type": "暂无证据|可迁移确认",
      "question": "具体、可直接回答的追问",
      "target_project": "若信息应补进某条已有经历，填项目名；否则空字符串"
    }
  ]
}

强约束：
1. match_status 为「暂无证据」的能力，gap_type 填「暂无证据」，question 必须问一个用户能回答的事实问题（例：「你参与 AI 音乐生成模块时做过效果评测吗？用的什么方法？」），禁止笼统问「请补充相关经验」。
2. match_status 为「可迁移」的能力，gap_type 填「可迁移确认」，question 写成让用户确认或修正改写表达的一句话，target_project 填匹配到的项目名。
3. 每条缺口只问一类信息；一次最多输出 3 条，按对岗位的重要性排序。
4. missing_abilities 中每项都必须出现在 gaps 中，不得遗漏。`;

  const RESUME_V3_SCHEMA = {
    type:'object',additionalProperties:false,
    properties:{
      summary:{type:'string'},
      projects:{type:'array',items:{type:'object',additionalProperties:false,properties:{
        project_name:{type:'string'},background:{type:'string'},responsibilities:{type:'string'},
        actions:{type:'string'},results:{type:'string'},
        fact_map:{type:'object',additionalProperties:false,properties:{
          background:{type:'string'},responsibilities:{type:'string'},
          actions:{type:'string'},results:{type:'string'}},
          required:['background','responsibilities','actions','results']}},
        required:['project_name','background','responsibilities','actions','results','fact_map']}},
      skills:{type:'array',items:{type:'string'}}
    },required:['summary','projects','skills']
  };
  // PROMPTS.md 节点 5 · V3 全文
  const PROMPT_RESUME_V3 = `你是岗位定向简历生成助手。基于已确认经历生成「一岗一版」简历：事实层严格，表达层可改写。

输入：JD 能力画像 + 已确认经历（原文 + 已确认标签）+ 匹配结果 + 用户已采纳的迁移表达。

输出：只输出一个 JSON 对象：
{
  "summary": "个人概述，事实可追溯",
  "projects": [
    {
      "project_name": "与原始经历完全一致",
      "background": "项目背景",
      "responsibilities": "个人职责，保留原职责强度",
      "actions": "具体行动",
      "results": "仅使用原文提供的结果，原文没有则空字符串",
      "fact_map": {
        "background": "支撑 background 的原文连续片段",
        "responsibilities": "支撑职责的原文连续片段",
        "actions": "支撑行动的原文连续片段",
        "results": "支撑结果的原文连续片段；原文无结果则空字符串"
      }
    }
  ],
  "skills": ["只使用已确认的能力标签"]
}

两层规则：
【事实层】
1. fact_map 的每项值必须是该条经历原文中真实存在的连续片段，不得改写、拼接或凭空生成；无法支撑时该字段的可写文本也必须为空。
2. 生成文本中出现的数字必须能在原文核到；原文无结果时 results 必须为空字符串。
3. 职责强度词不得升级：「参与/协助」不能写成「主导/独立负责/牵头」；项目名必须与原文完全一致。
4. 只能使用已确认经历与标签，禁止使用待确认内容；不得新增原文不存在的能力标签。
【表达层】
5. responsibilities / actions / background 允许按 JD 措辞改写与重排重点，只要 fact_map 能映射回原文且第 2、3 条不被违反。
6. 若输入中给出「用户已采纳的迁移表达」，优先采用该措辞；它仍然受第 2、3 条约束。
7. 根据匹配结果排序项目：有直接证据优先，可迁移次之，暂无证据最后。`;
  // PROMPTS.md 节点 6 · V3 全文
  const PROMPT_VALIDATE_V3 = `你是简历事实校验助手。按「事实层严格、表达层可改写」的标准对照已确认经历检查生成简历。

输入：已确认经历原文 + 已确认标签 + 生成简历（含 fact_map）+ 用户已采纳的迁移表达。

输出：只输出一个 JSON 对象：
{
  "risk_level": "高|中|低",
  "risk_items": [
    {
      "content": "存在风险的表述",
      "risk_type": "事实点未映射|职责夸大|虚构数据|项目名不一致|新增未提供内容|待确认写成事实",
      "level": "高|中|低",
      "original_evidence": "对应的原文片段，无则空字符串",
      "suggestion": "修改建议"
    }
  ]
}

强约束：
1. 表达层改写本身不是风险：只要 fact_map 的对应项能在原文找到，且数字、职责强度、项目名未变，就不要标为风险。
2. fact_map 任一项不是原文连续片段，或生成字段有内容但没有事实映射，标为「事实点未映射」（高）。
3. 职责强度升级（参与→主导）、原文没有的数字、原文无结果却写结果、项目名不一致、未确认标签，均标高风险。
4. 采纳过的迁移表达若违反第 3 条，同样标高风险——用户采纳不等于事实成立。
5. 每项风险给出 original_evidence；找不到时输出空字符串，不得编造。
6. 只标注风险，不直接改写简历；最终以用户人工审核为准。`;

  function validateMatchV3Result(data){
    if(!data||typeof data!=='object'||Array.isArray(data)) throw new Error('输出必须是 JSON 对象');
    if(!Array.isArray(data.matches)||!Array.isArray(data.missing_abilities)) throw new Error('matches / missing_abilities 必须是数组');
    data.matches.forEach((m,i)=>{
      for(const k of ['ability','experience','evidence','match_status','reasoning','transfer_fact','transfer_phrase'])
        if(typeof m?.[k]!=='string') throw new Error('matches 第 '+(i+1)+' 项字段 '+k+' 必须是字符串');
      if(MATCH_STATUS_V3.indexOf(m.match_status)===-1) throw new Error('matches 第 '+(i+1)+' 项状态非法');
    });
    return data;
  }
  function validateGapV3Result(data){
    if(!data||typeof data!=='object'||Array.isArray(data)) throw new Error('输出必须是 JSON 对象');
    if(!Array.isArray(data.gaps)) throw new Error('gaps 必须是数组');
    data.gaps.forEach((g,i)=>{
      for(const k of ['ability','gap_type','question','target_project'])
        if(typeof g?.[k]!=='string') throw new Error('gaps 第 '+(i+1)+' 项字段 '+k+' 必须是字符串');
      if(['暂无证据','可迁移确认','待确认'].indexOf(g.gap_type)===-1) throw new Error('gaps 第 '+(i+1)+' 项 gap_type 非法');
    });
    return data;
  }
  function validateResumeV3Result(data){
    if(!data||typeof data!=='object'||Array.isArray(data)) throw new Error('输出必须是 JSON 对象');
    for(const k of RESUME_V3_SCHEMA.required) if(!(k in data)) throw new Error('缺少字段：'+k);
    if(typeof data.summary!=='string'||!Array.isArray(data.projects)||!Array.isArray(data.skills))
      throw new Error('summary/projects/skills 类型错误');
    data.projects.forEach((p,i)=>{
      for(const k of ['project_name','background','responsibilities','actions','results'])
        if(typeof p?.[k]!=='string') throw new Error('projects 第 '+(i+1)+' 项字段 '+k+' 必须是字符串');
      if(!p.fact_map||typeof p.fact_map!=='object') throw new Error('projects 第 '+(i+1)+' 项缺少 fact_map');
      for(const k of ['background','responsibilities','actions','results'])
        if(typeof p.fact_map[k]!=='string') throw new Error('projects 第 '+(i+1)+' 项 fact_map.'+k+' 必须是字符串');
    });
    if(data.skills.some(x=>typeof x!=='string')) throw new Error('skills 必须是字符串数组');
    return data;
  }
  // 本地校验迁移表达：事实点必须是原文子串；改写草稿不得出现新数字或升级职责强度
  function enforceTransferV3(matches, corpus, exps){
    const corpusText = corpus.join('\n');
    const names = exps.map(e=>e.project_name);
    const strong = /(主导|独立负责|牵头|负责整个|从\s*0\s*到\s*1|全权)/;
    const weak = /(参与|协助|配合)/;
    const nums = s => (String(s||'').match(/\d+(?:\.\d+)?/g)||[]);
    return matches.map(m=>{
      const out = Object.assign({}, m);
      if(out.match_status==='有直接证据'){
        if(!out.evidence || corpusText.indexOf(out.evidence)===-1){
          out.evidence=''; out.match_status='暂无证据';
          out.reasoning=(out.reasoning||'')+' [本地校验：证据非原文，已降级]';
        }
        if(out.experience && names.indexOf(out.experience)===-1){
          out.experience=''; out.evidence=''; out.match_status='暂无证据';
          out.reasoning=(out.reasoning||'')+' [本地校验：项目名不在已确认经历，已降级]';
        }
      }else if(out.match_status==='可迁移'){
        const factOk = out.transfer_fact && corpusText.indexOf(out.transfer_fact)!==-1;
        const projectOk = out.experience && names.indexOf(out.experience)!==-1;
        const factNums = nums(out.transfer_fact), phraseNums = nums(out.transfer_phrase);
        const numOk = phraseNums.every(n=>factNums.indexOf(n)!==-1);
        const strongOk = !(weak.test(out.transfer_fact||'') && strong.test(out.transfer_phrase||''));
        if(!factOk || !projectOk || !numOk || !strongOk){
          out.match_status='暂无证据'; out.transfer_fact=''; out.transfer_phrase=''; out.evidence=''; out.experience='';
          out.reasoning=(out.reasoning||'')+' [本地校验：迁移事实/措辞越界，已降级]';
        }else{
          out.evidence=''; // 可迁移不是直接证据，禁止把改写草稿当证据
        }
      }
      if(out.match_status==='暂无证据'){ out.evidence=''; out.transfer_fact=''; out.transfer_phrase=''; }
      return out;
    });
  }
  // V3 本地事实校验：核对 fact_map 事实点映射 + 数字/强度词/标签高风险
  function localFactCheckV3(resume, src){
    const risks=[];
    const push=(content,risk_type,level,original_evidence,suggestion)=>
      risks.push({content,risk_type,level,original_evidence,suggestion,source:'本地'});
    const nums = s => (String(s||'').match(/\d+(?:\.\d+)?/g)||[]);
    const strong = /(主导|独立负责|牵头|负责整个|从\s*0\s*到\s*1|全权)/;
    const weak = /(参与|协助|配合)/;
    (resume.projects||[]).forEach(p=>{
      const s = src.byName[p.project_name];
      if(!s){ push('项目「'+p.project_name+'」不在已确认经历中','项目名不一致','高','',
        '删除该项目，或先在经历库补录并确认这段经历'); return }
      const raw = s.raw||'';
      const fm = p.fact_map||{};
      [['background','项目背景'],['responsibilities','个人职责'],['actions','具体行动'],['results','项目结果']].forEach(([k,label])=>{
        const text=String(p[k]||''), fact=String(fm[k]||'');
        if(!text) return;
        if(!fact) push('「'+p.project_name+'」'+label+'缺少 fact_map 事实映射','事实点未映射','中','',
          '补上支撑该表述的原文片段，或删掉这句话');
        else if(raw.indexOf(fact)===-1) push('「'+p.project_name+'」'+label+'的 fact_map 不是原文连续片段','事实点未映射','高',fact,
          '把 fact_map 改成经历原文中真实存在的一段话');
        // 即使 fact_map 缺失，仍用整条原文兜底检查数字与强度词，不能让中风险掩盖高风险
        const genNums=nums(text), srcNums=nums(raw);
        const invented=genNums.filter(n=>srcNums.indexOf(n)===-1);
        if(invented.length) push('「'+p.project_name+'」'+label+'含原文没有的数字：'+invented.join('、'),
          '虚构数据','高',fact||raw.slice(0,80),'删除或改回原文真实数据');
        if((weak.test(fact)||weak.test(raw)) && strong.test(text))
          push('「'+p.project_name+'」'+label+'把参与/协助写成了主导','职责夸大','高',fact||raw.slice(0,80),
            '改回原文强度，如「参与」「协助」');
      });
      if(!(s.fields.results||'') && p.results)
        push('「'+p.project_name+'」原文无结果，简历却写了结果','新增未提供内容','高','',
          '结果字段留空；如需写成果，先补充真实结果并确认');
    });
    (resume.skills||[]).forEach(sk=>{
      const label=String(sk).trim();
      if(label && !src.confirmedSkillSet.has(label))
        push('能力标签「'+label+'」不是已确认标签','待确认写成事实','高','',
          '删除该标签，或先到经历库确认包含该能力的标签');
    });
    if(nums(resume.summary).some(n=>nums(src.allRaw).indexOf(n)===-1))
      push('个人概述含原文没有的数字','虚构数据','高','','概述中删除该数字，只保留可追溯信息');
    return risks;
  }
  function sortProjectsByMatchV3(projects, matchRecord){
    if(!matchRecord||!Array.isArray(matchRecord.matches)) return projects;
    const rank={};
    matchRecord.matches.forEach(m=>{ rank[m.experience]=
      m.match_status==='有直接证据'?0:m.match_status==='可迁移'?1:2 });
    return projects.slice().sort((a,b)=>(rank[a.project_name]??1)-(rank[b.project_name]??1));
  }
