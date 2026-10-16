// PLACEHOLDER - PART 1: PARSER
const MACHINE_KEYS = new Set(['async_io_limit','build_version','clocksource.current_clocksource','cpu_clock','cpu_cores','cpu_flags','cpu_manufacturer','cpu_model','cpu_sockets','cpu_summary','cpu_threads','hw_manufacturer','hw_model','kernel.numa_balancing','kernel.shmall','kernel.shmmax','kernel.shmmni','kernel.transparent_hugepage.enabled','mem_phys','mem_swap','memory_map_area_limit','open_file_limit','os_cpe_name','os_kernel_version','os_name','os_ppms_name','os_rlimit_nofile','os_user','platform','sap_retrieval_path','sap_retrieval_path_shared','sid','sapsystem','start_time','timezone_base_name','timezone_dst_name','timezone_name','timezone_offset','timezone_tz_name','topology_mem_info','topology_mem_type'])
const NETWORK_KEYS = new Set(['net_domain','net_hostnames','net_ip_addresses','net_nameserver_bindings','net_port_ephemeral_max_count','net_port_ranges','net_port_unreserved_ranges','net_publicname','net_publicports','net_realhostname','net.core.somaxconn','net.ipv4.tcp_max_syn_backlog','net.ipv4.tcp_rmem','net.ipv4.tcp_syn_retries','net.ipv4.tcp_timestamps','net.ipv4.tcp_tw_recycle','net.ipv4.tcp_tw_reuse','net.ipv4.tcp_window_scaling','net.ipv4.tcp_wmem'])

function getIndent(line){const m=line.match(/^(\s*)/);return m?m[1].length:0}
function parseLine(line){const t=line.trim();const eq=t.indexOf('=');if(eq===-1)return{key:t,value:null};return{key:t.substring(0,eq),value:t.substring(eq+1)}}

function buildRawTree(lines){
  const root=[],stack=[];let n=0
  for(const line of lines){const trimmed=line.trim();if(!trimmed)continue;const indent=getIndent(line);const node={key:'n'+(n++),title:trimmed,level:indent,children:[]};while(stack.length>0&&stack[stack.length-1].indent>=indent)stack.pop();if(stack.length===0)root.push(node);else stack[stack.length-1].node.children.push(node);stack.push({node,indent})}
  return root
}

function parseTopology(content){
  const lines=content.split('\n').map(l=>l.replace(/\r$/,''))
  const result={tenants:[],hosts:[],replicationRows:[],replicationRowsMain:[],rawTree:[],backupCatalogTypes:{},allMasters:''}
  result.rawTree=buildRawTree(lines)
  extractStructuredData(lines,result)
  return result
}

function extractStructuredData(lines,result){
  const aml=lines.find(l=>l.trim().startsWith('active_master='));if(aml)result.activeMaster=aml.trim().replace('active_master=','').split(':')[0]
  const allML=lines.find(l=>l.trim().startsWith('all_masters='));if(allML)result.allMasters=allML.trim().replace('all_masters=','')
  for(const line of lines){const t=line.trim();if(!result.systemSID&&t.startsWith('sid='))result.systemSID=t.replace('sid=','').trim();if(!result.hanaVersion&&t.startsWith('build_version='))result.hanaVersion=t.replace('build_version=','').trim();if(result.systemSID&&result.hanaVersion)break}
  let inDc=false,inMode=false,inOpmode=false;const modeVals=[],opmodeVals=[]
  for(const line of lines){const indent=getIndent(line);const{key,value}=parseLine(line);if(indent===2&&key==='datacenters'&&value===null){inDc=true;continue}if(inDc&&indent<=2&&value===null&&key!=='datacenters'&&key!=='')inDc=false;if(!inDc)continue;if(indent===4&&key==='mode'&&value===null){inMode=true;inOpmode=false;continue}if(indent===4&&key==='opmode'&&value===null){inOpmode=true;inMode=false;continue}if(indent===4&&key!=='mode'&&key!=='opmode'){inMode=false;inOpmode=false}if(inMode&&indent===6&&value!==null)modeVals.push(value);if(inOpmode&&indent===6&&value!==null)opmodeVals.push(value)}
  const uniqueModes=[...new Set(modeVals)],uniqueOpmodes=[...new Set(opmodeVals)]
  if(uniqueModes.length>0){const single=uniqueModes.length===1&&uniqueModes[0]==='primary'&&uniqueOpmodes.length===0;result.replicationStatus=single?'None (single site)':`Replication Mode: ${uniqueModes.join(' / ')} | Operation Mode: ${uniqueOpmodes.join(' / ')||'-'}`}
  let inDbs=false,curDbId='';const dbById={};result.backupCatalogTypes={}
  for(const line of lines){const indent=getIndent(line);const{key,value}=parseLine(line);if(indent===2&&key==='databases'&&value===null){inDbs=true;continue}if(inDbs&&indent<=2&&value===null&&key!=='databases'&&key!=='')inDbs=false;if(!inDbs)continue;if(indent===4&&value===null){curDbId=key;dbById[curDbId]=dbById[curDbId]||{}}if(indent===6&&key==='name'&&value!==null)dbById[curDbId].name=value;if(indent===6&&key==='last_catalog_backup_type'&&value!==null)dbById[curDbId].bct=value}
  for(const entry of Object.values(dbById)){if(!entry.name)continue;if(entry.bct)result.backupCatalogTypes[entry.name]=entry.bct;if(entry.name!=='SYSTEMDB'&&!result.tenants.includes(entry.name))result.tenants.push(entry.name)}
  extractHosts(lines,result)
  result.replicationRows=extractReplication(lines)
  // for canvas: only use main block (before ~dc_topologies) to avoid cycles from multi-site perspectives
  const dcStart=lines.findIndex(l=>l.trimStart().startsWith('~dc_topologies'))
  const mainLines=dcStart>=0?lines.slice(0,dcStart):lines
  result.replicationRowsMain=extractReplication(mainLines)
}

function extractHosts(lines,result){
  const NON_SERVICE=new Set(['dc_mappings','dc_net_info','group','role','host_actual_roles','host_config_roles','host_config_subpath','subpath','worker_actual_groups','worker_config_groups'])
  const HOST_SCALAR=new Set(['host_actual_roles','host_config_roles','host_config_subpath','subpath','group','worker_actual_groups','worker_config_groups','role'])
  let inHost=false,cur=null,curSvc=null,curPort=null,inInfo=false,inDcNet=false
  for(const line of lines){
    const indent=getIndent(line);const{key,value}=parseLine(line)
    if(indent===2&&key==='host'&&value===null){inHost=true;continue}
    if(inHost&&indent===2&&value===null&&key!=='host'&&key!==''){if(cur){result.hosts.push(cur);cur=null}inHost=false;continue}
    if(!inHost)continue
    if(indent===4&&value===null){if(cur)result.hosts.push(cur);cur={name:key,services:[],machineMetadata:{},networkMetadata:{},hostMeta:{}};curSvc=null;curPort=null;inInfo=false;inDcNet=false;continue}
    if(!cur)continue
    if(indent===6&&value!==null&&HOST_SCALAR.has(key)){cur.hostMeta[key]=value;continue}
    if(indent===6&&value===null){if(key==='dc_net_info'){inDcNet=true;curSvc=null}else if(NON_SERVICE.has(key)){inDcNet=false;curSvc=null}else{inDcNet=false;curSvc=key;curPort=null;inInfo=false}continue}
    if(indent===8&&value===null&&curSvc){const p=parseInt(key);if(!isNaN(p)){curPort=p;inInfo=false}continue}
    if(indent===10&&key==='info'&&value===null){inInfo=true;continue}
    if(inInfo&&indent<=10&&indent!==12&&value===null)inInfo=false
    if(indent===10&&curSvc&&curPort!==null&&!inInfo&&value!==null){if(key==='active'&&value==='yes'){if(!cur.services.find(s=>s.name===curSvc&&s.port===curPort))cur.services.push({name:curSvc,port:curPort,database:''})}if(key==='database'){const s=cur.services.find(s=>s.name===curSvc&&s.port===curPort);if(s)s.database=value}}
    if(inInfo&&indent===12&&value!==null){if(MACHINE_KEYS.has(key)){if(key==='mem_phys'||key==='mem_swap'){const b=parseInt(value);cur.machineMetadata[key]=isNaN(b)?value:`${Math.round(b/(1024**3))} GB (${value})`}else cur.machineMetadata[key]=value}if(NETWORK_KEYS.has(key))cur.networkMetadata[key]=value}
    if(inDcNet&&(indent===10||indent===12)&&value!==null){if(NETWORK_KEYS.has(key)){if(cur.networkMetadata[key]){const ex=cur.networkMetadata[key].split(', ');if(!ex.includes(value))cur.networkMetadata[key]+=`, ${value}`}else cur.networkMetadata[key]=value}}
  }
  if(cur&&inHost)result.hosts.push(cur)
}

function extractReplication(allLines){
  const rows=[];const blocks=collectTopologyBlocks(allLines)
  for(const block of blocks){const br=extractReplicationFromBlock(block);for(const row of br){const dup=rows.some(r=>r.primaryHost===row.primaryHost&&r.primaryPort===row.primaryPort&&r.secondaryHost===row.secondaryHost&&r.volumeId===row.volumeId);if(!dup)rows.push(row)}}
  rows.sort((a,b)=>{if(a.primaryHost!==b.primaryHost)return a.primaryHost.localeCompare(b.primaryHost);return a.primaryPort-b.primaryPort})
  return rows
}

function collectTopologyBlocks(allLines){
  const blocks=[];const dcStart=allLines.findIndex(l=>l.trimStart().startsWith('~dc_topologies'))
  const main=dcStart>=0?allLines.slice(0,dcStart):allLines;blocks.push(main)
  if(dcStart<0)return blocks
  let cur=[]
  for(let i=dcStart+1;i<allLines.length;i++){const line=allLines[i];const indent=getIndent(line);const trimmed=line.trim();if(indent===4&&trimmed!==''&&!trimmed.includes('=')&&/^\d+$/.test(trimmed)){if(cur.length>0)blocks.push(cur);cur=[];continue}cur.push(line.length>=4?line.substring(4):line)}
  if(cur.length>0)blocks.push(cur)
  return blocks
}

function extractReplicationFromBlock(lines){
  const rows=[]
  const dbNames={};let inDbs=false,curDbId=''
  for(const line of lines){const indent=getIndent(line);const{key,value}=parseLine(line);if(indent===2&&key==='databases'&&value===null){inDbs=true;continue}if(inDbs&&indent<=2&&value===null&&key!=='databases'&&key!=='')inDbs=false;if(!inDbs)continue;if(indent===4&&value===null)curDbId=key;if(indent===6&&key==='name'&&value!==null)dbNames[curDbId]=value}
  const siteMode={},siteName={},siteOpmode={},replicationChain={}
  let inDc2=false,inMode2=false,inName2=false,inOpmode2=false,inMaps=false,mapSrc=''
  for(const line of lines){const indent=getIndent(line);const{key,value}=parseLine(line);if(indent===2&&key==='datacenters'&&value===null){inDc2=true;continue}if(inDc2&&indent<=2&&value===null&&key!=='datacenters'&&key!==''){inDc2=false;continue}if(!inDc2)continue;if(indent===4){inMode2=key==='mode'&&value===null;inName2=key==='name'&&value===null;inOpmode2=key==='opmode'&&value===null;if(key==='mappings'&&value===null){inMaps=true;continue}else if(key!=='mappings')inMaps=false}if(inMode2&&indent===6&&value!==null)siteMode[key]=value.toUpperCase();if(inName2&&indent===6&&value!==null)siteName[key]=value;if(inOpmode2&&indent===6&&value!==null)siteOpmode[key]=value;if(inMaps&&indent===6&&value===null){mapSrc=key;replicationChain[key]=[];continue}if(inMaps&&indent===8&&value==='yes'&&replicationChain[mapSrc])replicationChain[mapSrc].push(key)}
  const primarySiteId=Object.entries(siteMode).find(([,m])=>m==='PRIMARY')?.[0]||'1'
  const RELEVANT=new Set(['nameserver','indexserver','xsengine']);const hostEntries=[]
  let inHS=false,curEnt=null,curSvcN='',inDcM=false,curS=null
  for(const line of lines){const indent=getIndent(line);const{key,value}=parseLine(line);if(indent===2&&key==='host'&&value===null){inHS=true;continue}if(inHS&&indent<=2&&value===null&&key!=='host'){inHS=false;continue}if(!inHS)continue;if(indent===4&&value===null){curEnt={dcMap:{},services:[]};hostEntries.push(curEnt);inDcM=false;curSvcN='';curS=null;continue}if(!curEnt)continue;if(indent===6&&key==='dc_mappings'&&value===null){inDcM=true;curSvcN='';continue}if(inDcM&&indent===6&&key!=='dc_mappings')inDcM=false;if(inDcM&&indent===8&&value!==null){curEnt.dcMap[key]=value;continue}if(indent===6&&value===null){inDcM=false;curSvcN=RELEVANT.has(key)?key:'';curS=null;continue}if(!curSvcN)continue;if(indent===8&&value===null){const p=parseInt(key);if(!isNaN(p)){curS={name:curSvcN,port:p,dbId:'',volume:''};curEnt.services.push(curS)}continue}if(indent===10&&curS&&value!==null){if(key==='database')curS.dbId=value;if(key==='volume')curS.volume=value}}
  for(const entry of hostEntries){const primH=entry.dcMap[primarySiteId];if(!primH)continue;for(const svc of entry.services){if(!svc.volume)continue;for(const[srcSite,targets]of Object.entries(replicationChain)){const pH=entry.dcMap[srcSite];if(!pH)continue;for(const tgt of targets){const sH=entry.dcMap[tgt];if(!sH)continue;const dbName=dbNames[svc.dbId]||(svc.dbId?svc.dbId:'SYSTEMDB');rows.push({database:dbName,primaryHost:pH,primaryPort:svc.port,serviceName:svc.name,volumeId:svc.volume,primarySiteId:parseInt(srcSite)||1,primarySiteName:siteName[srcSite]||`Site ${srcSite}`,secondaryHost:sH,secondaryPort:svc.port,secondarySiteId:parseInt(tgt)||2,secondarySiteName:siteName[tgt]||`Site ${tgt}`,secondaryActive:'YES',replicationMode:siteMode[tgt]||'UNKNOWN',operationMode:siteOpmode[tgt]||'',replicationStatus:'ACTIVE',statusDetails:'',fullySynced:false})}}}}
  const volInSync={};let inVols=false,curVId2='',inDcCfg=false,dcCfgSite=''
  for(const line of lines){const indent=getIndent(line);const{key,value}=parseLine(line);if(indent===2&&key==='volumes'&&value===null){inVols=true;continue}if(inVols&&indent<=2&&value===null&&key!=='volumes'&&key!==''){inVols=false;continue}if(!inVols)continue;if(indent===4&&value===null){curVId2=key;volInSync[key]={};inDcCfg=false;continue}if(indent===6&&key==='dc_config'&&value===null){inDcCfg=true;continue}if(indent===6&&key!=='dc_config')inDcCfg=false;if(inDcCfg&&indent===8&&value===null){dcCfgSite=key;continue}if(inDcCfg&&indent===10&&key==='in_sync'&&value!==null)volInSync[curVId2][dcCfgSite]=value==='yes'}
  for(const row of rows){const sm=volInSync[row.volumeId];const ts=String(row.secondarySiteId);if(sm&&sm[ts]!==undefined){row.fullySynced=sm[ts]}else{for(const[vId,sm2]of Object.entries(volInSync)){const parts=vId.split(':');if(parts[parts.length-1]===row.volumeId||parts[0]===row.volumeId){if(sm2[ts]!==undefined){row.fullySynced=sm2[ts];break}}}}}
  return rows
}

function toInt(s){if(!s||s==='-')return null;const n=parseInt(s);return isNaN(n)?null:n}
function extractRawBytes(stored){const m=stored.match(/\((\d+)\)/);if(m)return parseInt(m[1])||0;return parseInt(stored)||0}

function checkTcpIpParameters(net){
  const items=[]
  const checks=[['net.core.somaxconn',v=>toInt(v)>=4096,'>= 4096','2382421',v=>`Value ${toInt(v)} below 4096`],['net.ipv4.tcp_max_syn_backlog',v=>toInt(v)>=8192,'>= 8192','2382421',v=>`Value ${toInt(v)} below 8192`],['net.ipv4.tcp_window_scaling',v=>v==='1','1','2382421',()=>'Should be 1'],['net.ipv4.tcp_timestamps',v=>v==='1','1','2382421',()=>'Should be 1'],['net.ipv4.tcp_tw_recycle',v=>v==='-'||v==='0','- or 0','2382421',v=>`Value "${v}" can cause TCP issues`],['net.ipv4.tcp_syn_retries',v=>toInt(v)===8,'8','2382421',v=>`Value ${toInt(v)} differs from 8`]]
  for(const[k,ok,exp,note,warn]of checks){const v=net[k];if(v){const pass=ok(v);items.push({label:k,currentValue:v,expectedValue:exp,status:pass?'ok':'warning',sapNote:note,warning:pass?null:warn(v)})}}
  function tcpBufCheck(label,val){
    if(!val)return null
    const p=val.trim().split(/\s+/)
    const max=p.length===3?parseInt(p[2]):null
    if(max===null)return{label,currentValue:val,expectedValue:'see description',status:'warning',sapNote:'2382421',warning:'Could not parse value'}
    const maxMB=(max/1048576).toFixed(1)
    const ok=max>=4194304
    // Build descriptive warning/info text
    const desc=`Your current maximum is ${maxMB} MB. `+
      `Given a 10 GBit/s connection with a latency of 1 ms, the required maximum would be 10 GBit/s × 1 ms = 1.25 MB, therefore a setting of ${maxMB} MB is more than sufficient for this case. `+
      `If you want to saturate a 1 GBit/s connection with a latency of 100 ms, the required maximum is 1 GBit/s × 100 ms = 12.5 MB${max>=13107200?' — current setting is fine.':', so the setting should be adjusted to at least 12.5 MB.'} `+
      `The minimum and default buffer sizes do not need to be adjusted.`
    return{label,currentValue:val,expectedValue:`current max: ${maxMB} MB`,status:ok?'ok':'warning',sapNote:'2382421',warning:ok?null:desc,_infoText:desc}
  }
  const rmem=net['net.ipv4.tcp_rmem'];if(rmem){const r=tcpBufCheck('net.ipv4.tcp_rmem',rmem);if(r)items.push(r)}
  const wmem=net['net.ipv4.tcp_wmem'];if(wmem){const r=tcpBufCheck('net.ipv4.tcp_wmem',wmem);if(r)items.push(r)}
  const reuse=net['net.ipv4.tcp_tw_reuse'];if(reuse){const v=toInt(reuse),ok=v!==null&&v>=1;items.push({label:'net.ipv4.tcp_tw_reuse',currentValue:reuse,expectedValue:'2 (SLES 15 SP2+) or 1',status:ok?'ok':'warning',sapNote:'2382421',warning:ok?null:'Recommended >= 1 (value 2 for SLES 15 SP2+).'})}
  return items
}

function checkKernelParameters(mach){
  const items=[]
  const numa=mach['kernel.numa_balancing'];if(numa)items.push({label:'kernel.numa_balancing',currentValue:numa,expectedValue:'0',status:numa==='0'?'ok':'warning',sapNote:'2382421',warning:numa!=='0'?`NUMA balancing enabled (${numa})`:null})
  const shmmax=mach['kernel.shmmax'];if(shmmax){const v=parseInt(shmmax)||0,ok=v>=1073741824;items.push({label:'kernel.shmmax',currentValue:shmmax,expectedValue:'>= 1 GB',status:ok?'ok':'warning',sapNote:'SAP HANA Platform',warning:ok?null:`Value ${v.toLocaleString()} below 1 GB`})}
  const shmmni=mach['kernel.shmmni'];if(shmmni){const v=parseInt(shmmni)||0,ok=v===32768;items.push({label:'kernel.shmmni',currentValue:shmmni,expectedValue:'32768',status:ok?'ok':'warning',sapNote:'SAP HANA Platform',warning:ok?null:`Value ${v} differs from 32768`})}
  const shmall=mach['kernel.shmall'],memB=extractRawBytes(mach['mem_phys']||'')
  if(shmall&&memB>0){const TB35=35.5*1099511627776;let exp;if(memB>=TB35){const sm=parseInt(mach['kernel.shmmax']||'0')||0,sn=parseInt(mach['kernel.shmmni']||'0')||0;exp=sm>0&&sn>0?Math.floor(sm*sn/65536):0}else exp=Math.floor(0.9*memB/4096);const ok=BigInt(shmall)>=BigInt(Math.floor(exp));items.push({label:'kernel.shmall',currentValue:shmall,expectedValue:`>= ${exp.toLocaleString()}`,status:ok?'ok':'warning',sapNote:'SAP HANA Platform',warning:ok?null:`Value may be below minimum ${exp.toLocaleString()}`})}
  const thp=mach['kernel.transparent_hugepage.enabled'];if(thp){const ok=thp.includes('[madvise]')||thp.trim()==='madvise';items.push({label:'Transparent Huge Pages (THP)',currentValue:thp,expectedValue:'always [madvise] never',status:ok?'ok':'warning',sapNote:'2131662',warning:ok?null:`Current: "${thp}". SAP recommends "always [madvise] never".`})}
  return items
}

// ============================================================
// HTML RENDERER
// ============================================================
function escHtml(s){return String(s||'').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;')}
function tag(cls,text){return `<span class="tag ${cls}">${escHtml(text)}</span>`}
function monoCell(val){return `<span class="mono">${escHtml(val)}</span>`}
function renderDescTable(rows){if(!rows.length)return '<span style="color:#A19F9D;font-size:12px;">No data.</span>';let html='<table class="desc-table">';for(const[label,val,extra]of rows)html+=`<tr><td>${escHtml(label)}</td><td>${val}${extra||''}</td></tr>`;return html+'</table>'}
const SWAP_WARN=2*1024*1024*1024

const MACHINE_GROUPS=[
  {title:'Operating System',fields:[['os_name','OS Name'],['os_kernel_version','Kernel Version'],['os_cpe_name','CPE Name'],['os_ppms_name','PPMS Name'],['os_user','OS User'],['os_rlimit_nofile','File Limit (rlimit)'],['open_file_limit','Open File Limit'],['platform','Platform']]},
  {title:'Hardware',fields:[['hw_manufacturer','Manufacturer'],['hw_model','Model'],['cpu_model','CPU Model'],['cpu_manufacturer','CPU Manufacturer'],['cpu_summary','CPU Summary'],['cpu_sockets','CPU Sockets'],['cpu_cores','CPU Cores'],['cpu_threads','CPU Threads'],['cpu_clock','CPU Clock (MHz)']]},
  {title:'Memory',fields:[['mem_phys','Physical RAM'],['mem_swap','Swap Space'],['memory_map_area_limit','Memory Map Area Limit'],['async_io_limit','Async I/O Limit']]},
  {title:'SAP HANA',fields:[['build_version','HANA Version'],['sid','SID'],['sapsystem','System Nr.'],['sap_retrieval_path','Retrieval Path'],['sap_retrieval_path_shared','Shared Path'],['topology_mem_info','Topology Memory Info'],['topology_mem_type','Topology Memory Type'],['start_time','Start Time']]},
  {title:'Timezone',fields:[['timezone_name','Timezone'],['timezone_base_name','Base Name'],['timezone_dst_name','DST Name'],['timezone_offset','Offset (seconds)'],['timezone_tz_name','TZ Name']]},
]
const NETWORK_GROUPS=[{title:'Host Network',fields:[['net_hostnames','Hostnames'],['net_ip_addresses','IP Addresses'],['net_domain','Domain'],['net_publicname','Public Name'],['net_publicports','Public Ports'],['net_realhostname','Real Hostname'],['net_nameserver_bindings','Nameserver Bindings'],['net_port_ranges','Port Ranges'],['net_port_unreserved_ranges','Unreserved Port Ranges'],['net_port_ephemeral_max_count','Ephemeral Port Count']]}]

function renderMetaGroup(meta,group){
  const rows=[]
  for(const[key,label]of group.fields){const val=meta[key];if(!val)continue
    if(key==='mem_swap'){
      const bytes=extractRawBytes(val);const warn=bytes>SWAP_WARN
      const color=warn?'color:#D46B08;':''
      const tip=warn?` <span title="Swap > 2 GB — SAP Note 2779331" style="cursor:help">⚠️</span>`:''
      rows.push([label,`<span class="mono" style="${color}">${escHtml(val)}</span>`,tip])
    } else if(key==='timezone_offset'&&val){
      const secs=parseInt(val)
      if(!isNaN(secs)){
        const sign=secs>=0?'+':'-';const abs=Math.abs(secs)
        const h=Math.floor(abs/3600),m=Math.floor((abs%3600)/60)
        const utc=`UTC${sign}${h}${m>0?':'+String(m).padStart(2,'0'):''}`
        rows.push([label,`<span class="mono">${escHtml(val)}s &nbsp;<a href="https://www.timeanddate.com/time/utc-offsets.html" target="_blank" style="font-size:11px;">${utc}</a></span>`])
      } else rows.push([label,monoCell(val)])
    } else if(['timezone_name','timezone_base_name','timezone_dst_name'].includes(key)&&val&&val!=='-'){
      rows.push([label,`<a href="https://www.timeanddate.com/time/zones/${encodeURIComponent(val.toLowerCase())}" target="_blank" class="mono">${escHtml(val)}</a>`])
    } else rows.push([label,monoCell(val)])
  }
  return rows
}

function renderCollapsePanel(id,headerHtml,bodyHtml,open){return `<div class="collapse-panel${open?' open':''}" id="${id}"><div class="collapse-header" onclick="toggleCollapse('${id}')"><span>${headerHtml}</span><span class="collapse-arrow">&#9654;</span></div><div class="collapse-body">${bodyHtml}</div></div>`}

function renderParamChecks(items){
  if(!items.length)return '<span style="color:#A19F9D;font-size:12px;">No data.</span>'
  let html='<table class="desc-table">'
  for(const item of items){
    const isWarn=item.status==='warning'
    const sapLink=`<a href="https://me.sap.com/notes/${encodeURIComponent(item.sapNote)}" target="_blank" class="sap-note">SAP Note ${item.sapNote}</a>`
    let extra=''
    if(item._infoText){
      // always show the descriptive text inline (not just as tooltip)
      extra=`<div style="margin-top:4px;color:#605E5C;font-size:11px;line-height:1.5;">${escHtml(item._infoText)}</div>`
    } else if(item.warning){
      extra=`<span title="${escHtml(item.warning)}" style="cursor:help;margin-left:4px;">⚠️</span>`
    }
    html+=`<tr${isWarn?' class="param-row-warn"':''}>
      <td><code style="font-size:11px;${isWarn?'color:#D46B08;':''}">${escHtml(item.label)}</code></td>
      <td>
        <span class="mono" style="${isWarn?'color:#D46B08;':''}">${escHtml(item.currentValue)}</span>
        <span style="color:#A19F9D;margin:0 6px;">→</span>
        <span style="color:#605E5C;font-size:11px;">${escHtml(item.expectedValue)}</span>
        ${sapLink}
        ${extra}
      </td>
    </tr>`
  }
  return html+'</table>'
}

function renderServicesCard(services){
  if(!services.length)return '<div class="card"><div class="card-title">⚙️ Services</div><div class="card-body"><span style="color:#A19F9D;">No active services.</span></div></div>'
  let html=`<div class="card"><div class="card-title">⚙️ Services</div><div class="card-body"><table class="data-table"><thead><tr><th>Service</th><th>Port</th><th>Database</th></tr></thead><tbody>`
  for(const s of services)html+=`<tr><td>${escHtml(s.name)}</td><td><code>${escHtml(String(s.port))}</code></td><td>${escHtml(s.database||'-')}</td></tr>`
  return html+'</tbody></table></div></div>'
}

function renderHostPanel(host,panelId){
  const tcp=checkTcpIpParameters(host.networkMetadata),kern=checkKernelParameters(host.machineMetadata)
  let html=`<div class="btns-row"><button class="btn-sm" onclick="expandAll('${panelId}')">Expand All</button><button class="btn-sm" onclick="collapseAll('${panelId}')">Collapse All</button></div>`
  html+=renderServicesCard(host.services)
  let machBody='';const kernWarn=kern.some(c=>c.warning);const memSwap=host.machineMetadata['mem_swap'];const memWarn=!!(memSwap&&extractRawBytes(memSwap)>SWAP_WARN)
  for(let gi=0;gi<MACHINE_GROUPS.length;gi++){const g=MACHINE_GROUPS[gi];const rows=renderMetaGroup(host.machineMetadata,g);if(!rows.length)continue;let grpHdr=escHtml(g.title);if(g.title==='Operating System')grpHdr+=` <a href="https://me.sap.com/notes/2235581" target="_blank" class="sap-note" onclick="event.stopPropagation()">SAP Note 2235581</a>`;if(g.title==='Memory'&&memWarn)grpHdr+=' ⚠️';machBody+=renderCollapsePanel(`${panelId}-mach-${gi}`,grpHdr,renderDescTable(rows));if(g.title==='Operating System'){const kernHdr=`Kernel Parameters <a href="https://me.sap.com/notes/2131662" target="_blank" class="sap-note" onclick="event.stopPropagation()">SAP Note 2131662</a>${kernWarn?' ⚠️':''}`;machBody+=renderCollapsePanel(`${panelId}-kern`,kernHdr,renderParamChecks(kern))}}
  html+=`<div class="card"><div class="card-title">🖥️ Machine</div><div class="card-body">${machBody||'<span style="color:#A19F9D;">No data.</span>'}</div></div>`
  let netBody='';const tcpWarn=tcp.some(c=>c.warning)
  for(let gi=0;gi<NETWORK_GROUPS.length;gi++){const g=NETWORK_GROUPS[gi];const rows=renderMetaGroup(host.networkMetadata,g);if(!rows.length)continue;netBody+=renderCollapsePanel(`${panelId}-net-${gi}`,escHtml(g.title),renderDescTable(rows));if(g.title==='Host Network'){const tcpHdr=`TCP/IP Parameters <a href="https://me.sap.com/notes/2382421" target="_blank" class="sap-note" onclick="event.stopPropagation()">SAP Note 2382421</a>${tcpWarn?' ⚠️':''}`;netBody+=renderCollapsePanel(`${panelId}-tcp`,tcpHdr,renderParamChecks(tcp))}}
  html+=`<div class="card"><div class="card-title">📡 Network</div><div class="card-body">${netBody||'<span style="color:#A19F9D;">No data.</span>'}</div></div>`
  return html
}

function renderDashboard(data){
  const hostVersions=data.hosts.map(h=>({host:h.name,v:h.machineMetadata['build_version']||''})).filter(h=>h.v)
  const hostOS=data.hosts.map(h=>({host:h.name,v:h.machineMetadata['os_name']||''})).filter(h=>h.v)
  const hostKernel=data.hosts.map(h=>({host:h.name,v:h.machineMetadata['os_kernel_version']||''})).filter(h=>h.v)
  const hostInst=data.hosts.map(h=>({host:h.name,v:h.machineMetadata['sapsystem']||''})).filter(h=>h.v)
  const uniqueVers=[...new Set(hostVersions.map(h=>h.v))];const mixed=uniqueVers.length>1
  const uniqueOS=[...new Set(hostOS.map(h=>h.v))];const mixedOS=uniqueOS.length>1
  const uniqueKernel=[...new Set(hostKernel.map(h=>h.v))];const mixedKernel=uniqueKernel.length>1
  const uniqueInst=[...new Set(hostInst.map(h=>h.v))];const mixedInst=uniqueInst.length>1
  const sysRows=[]
  sysRows.push(['System SID',data.systemSID?tag('tag-blue',data.systemSID):'<span style="color:#A19F9D;">-</span>'])
  sysRows.push(['Instance',mixedInst?tag('tag-warn','Mixed — see below'):escHtml(uniqueInst[0]||'-')])
  sysRows.push(['HANA Version',mixed?tag('tag-warn','Mixed — see below'):escHtml(uniqueVers[0]||data.hanaVersion||'-')])
  sysRows.push(['OS',mixedOS?tag('tag-warn','Mixed — see below'):escHtml(uniqueOS[0]||'-')])
  sysRows.push(['Kernel Version',mixedKernel?tag('tag-warn','Mixed — see below'):escHtml(uniqueKernel[0]||'-')])
  sysRows.push(['Active Master',data.activeMaster?tag('tag-green',data.activeMaster):'<span style="color:#A19F9D;">-</span>'])
  sysRows.push(['Tenants',data.tenants.map(t=>tag('tag-purple',t)).join(' ')||'<span style="color:#A19F9D;">-</span>'])
  const bct=data.backupCatalogTypes||{},allDbs=['SYSTEMDB',...data.tenants]
  sysRows.push(['Last Backup Type',allDbs.map(db=>`${tag('tag-purple',db)} <span class="mono" style="margin-right:10px;">${escHtml(bct[db]||'-')}</span>`).join('')])
  let html=`<div class="card"><div class="card-title">📊 System Information</div><div class="card-body"><table class="desc-table">`
  for(const[l,v]of sysRows)html+=`<tr><td>${escHtml(l)}</td><td>${v}</td></tr>`
  html+='</table></div></div>'

  if(data.hosts.length>1){
    html+=`<div class="card"><div class="card-title">🔀 Multiple-Host / Scale-out</div><div class="card-body"><div class="data-table-wrap"><table class="data-table"><thead><tr>
      <th>Host</th><th>Host Active</th><th>Host Status</th><th>Storage Partition</th>
      <th>NameServer Config Role</th><th>NameServer Actual Role</th><th>IndexServer Config Role</th>
      <th>Host Config Roles</th><th>Host Actual Roles</th><th>Worker Config Groups</th><th>Worker Actual Groups</th>
    </tr></thead><tbody>`
    for(const h of data.hosts){
      const hm=h.hostMeta||{};const isAM=h.name===data.activeMaster
      const nsSvc=h.services.find(s=>s.name==='nameserver')
      const partition=hm['subpath']||hm['host_config_subpath']||'-'
      const allMasters=(data.allMasters||'').split(' ').map(m=>m.split(':')[0]).filter(Boolean)
      const masterIdx=allMasters.indexOf(h.name)
      const isMasterHost=isAM||masterIdx>=0
      const masterNum=isAM?1:(masterIdx>=0?masterIdx+1:null)
      const nsConfigRole=isMasterHost?`master ${masterNum}`:'slave'
      const nsActualRole=isAM?'master':'slave'
      const ixConfigRole=hm['host_config_roles']||'-'
      const masterStyle=isAM?'color:#0078D4;font-weight:600;':''
      html+=`<tr>
        <td>${tag(isAM?'tag-green':'tag-cyan',h.name)}</td>
        <td><span class="badge-success">${escHtml(nsSvc?'yes':'-')}</span></td>
        <td><span class="badge-success">ok</span></td>
        <td><span class="mono">${escHtml(partition)}</span></td>
        <td><span class="mono" style="${masterStyle}">${escHtml(nsConfigRole)}</span></td>
        <td><span class="mono" style="${masterStyle}">${escHtml(nsActualRole)}</span></td>
        <td><span class="mono">${escHtml(ixConfigRole)}</span></td>
        <td><span class="mono">${escHtml(hm['host_config_roles']||'-')}</span></td>
        <td><span class="mono">${escHtml(hm['host_actual_roles']||'-')}</span></td>
        <td><span class="mono">${escHtml(hm['worker_config_groups']||'-')}</span></td>
        <td><span class="mono">${escHtml(hm['worker_actual_groups']||'-')}</span></td>
      </tr>`
    }
    html+='</tbody></table></div></div></div>'
  }

  if(data.replicationRows.length){
    const modes=[...new Set(data.replicationRows.map(r=>r.replicationMode))].join(' / ')
    html+=`<div class="card"><div class="card-title"><span class="badge-proc"></span>System Replication <span class="tag tag-cyan" style="margin-left:6px;">${escHtml(modes)}</span></div><div class="card-body"><div class="data-table-wrap"><table class="data-table"><thead><tr><th>Database</th><th>Primary Host</th><th>Port</th><th>Service</th><th>Vol.</th><th>Site ID</th><th>Site Name</th><th>Secondary Host</th><th>Sec. Site</th><th>Replication Mode</th><th>Operation Mode</th><th>Status</th><th>Fully Synced</th></tr></thead><tbody>`
    for(const r of data.replicationRows){const modeTag=r.replicationMode==='SYNC'?tag('tag-green',r.replicationMode):r.replicationMode==='ASYNC'?tag('tag-cyan',r.replicationMode):r.replicationMode==='SYNCMEM'?tag('tag-purple',r.replicationMode):tag('tag-orange',r.replicationMode);const opmodeVal=r.operationMode?`<span class="mono">${escHtml(r.operationMode)}</span>`:'<span style="color:#A19F9D;">-</span>';const statusBadge=r.replicationStatus==='ACTIVE'?`<span class="badge-success">${escHtml(r.replicationStatus)}</span>`:`<span class="badge-warning">${escHtml(r.replicationStatus)}</span>`;const syncBadge=r.fullySynced?'<span class="badge-success">Yes</span>':'<span class="badge-warning">No</span>';html+=`<tr><td>${tag('tag-purple',r.database)}</td><td>${escHtml(r.primaryHost)}</td><td><code>${r.primaryPort}</code></td><td>${escHtml(r.serviceName)}</td><td>${escHtml(r.volumeId)}</td><td>${r.primarySiteId}</td><td>${escHtml(r.primarySiteName)}</td><td>${escHtml(r.secondaryHost)}</td><td>${r.secondarySiteId}: ${escHtml(r.secondarySiteName)}</td><td>${modeTag}</td><td>${opmodeVal}</td><td>${statusBadge}</td><td>${syncBadge}</td></tr>`}
    html+='</tbody></table></div>'
    // info note when topology contains ~dc_topologies (multi-site perspective blocks)
    const hasDcTopo=(data.replicationRowsMain&&data.replicationRowsMain.length<data.replicationRows.length)
    if(hasDcTopo){
      const totalRows=data.replicationRows.length
      const mainRows=data.replicationRowsMain.length
      const extraRows=totalRows-mainRows
      // collect unique sites from all rows
      const siteNames={}
      for(const r of data.replicationRows){siteNames[r.primarySiteId]=r.primarySiteName;siteNames[r.secondarySiteId]=r.secondarySiteName}
      const siteList=Object.entries(siteNames).sort((a,b)=>parseInt(a[0])-parseInt(b[0])).map(([id,name])=>`Site ${id}: ${name}`).join(', ')
      // primary site = the one with inDeg 0 in the main block
      const mainEdges={}
      for(const r of data.replicationRowsMain){const k=`${r.primarySiteId}->${r.secondarySiteId}`;if(!mainEdges[k])mainEdges[k]={from:r.primarySiteId,to:r.secondarySiteId}}
      const inDeg={}
      for(const r of data.replicationRowsMain){if(inDeg[r.primarySiteId]===undefined)inDeg[r.primarySiteId]=0;if(inDeg[r.secondarySiteId]===undefined)inDeg[r.secondarySiteId]=0}
      for(const e of Object.values(mainEdges))inDeg[e.to]++
      const primarySiteId=Object.keys(inDeg).find(id=>inDeg[id]===0)
      const primarySiteName=primarySiteId?siteNames[primarySiteId]:'unknown'

      // detect conflicting edges (takeover scenario): any sub-block edge that is reverse of a main-block edge
      const mainEdgeKeys=new Set(Object.keys(mainEdges))
      const allEdgeKeys=new Set()
      for(const r of data.replicationRows)allEdgeKeys.add(`${r.primarySiteId}->${r.secondarySiteId}`)
      const hasConflict=[...allEdgeKeys].some(k=>{const[a,b]=k.split('->');return mainEdgeKeys.has(`${b}->${a}`)})

      const conflictNote=hasConflict
        ?`<br><strong>⚠️ Conflicting edge directions detected:</strong> One or more sub-topology blocks contain <strong>reverse mappings</strong> (e.g. Site 2→1 while the main block shows 1→2). This typically occurs after a <strong>takeover</strong>, where each site reports a different "who is primary" perspective. Combined, these create bidirectional edges (cycles) in the graph — the BFS layout algorithm cannot determine a root site, which is why the canvas would render empty without this workaround.`
        :`<br>The sub-topology blocks show consistent mapping directions (no conflicting edges detected) — likely a secondary site reporting the same perspective as the primary.`

      html+=`<div style="margin-top:6px;padding:8px 12px;background:#FFF4CE;border:1px solid #FFD335;border-radius:2px;font-size:11px;color:#7A4F00;line-height:1.7;">
        <strong>ℹ️ Multi-site topology detected (~dc_topologies)</strong><br>
        This topology.txt was collected from a system with multiple HSR sites and contains <strong>${Object.keys(siteNames).length} site perspectives</strong> embedded as <code>~dc_topologies</code> sub-blocks.<br>
        <strong>Sites detected:</strong> ${escHtml(siteList)}<br>
        <strong>Replication table:</strong> Shows <strong>all ${totalRows} rows</strong> from all site perspectives (including ${extraRows} rows from sub-topology blocks).<br>
        <strong>Replication Visual Overview:</strong> Uses only the <strong>${mainRows} rows from the primary site perspective</strong> (Site ${primarySiteId}: ${escHtml(primarySiteName)}) to avoid rendering cycles caused by bidirectional edges from competing site views.
        ${conflictNote}
      </div>`
    }
    html+='</div></div>'
    html+=`<div class="card"><div class="card-title">🗺️ Replication Visual Overview</div><div class="card-body" style="padding:0;position:relative;"><canvas id="topo-canvas" style="width:100%;display:block;"></canvas><div id="topo-overlays" style="position:absolute;top:0;left:0;pointer-events:none;"></div></div></div>`
  }

  const allWarnings=[]
  for(const h of data.hosts){
    const tcpW=checkTcpIpParameters(h.networkMetadata).filter(c=>c.warning)
    const kernW=checkKernelParameters(h.machineMetadata).filter(c=>c.warning)
    const swap=h.machineMetadata['mem_swap']
    if(swap&&extractRawBytes(swap)>SWAP_WARN){const b=extractRawBytes(swap);allWarnings.push({host:h.name,param:'Swap Space',warning:`Swap of ${(b/(1024**3)).toFixed(1)} GB exceeds recommended 2 GB.`,sapNote:'2779331'})}
    for(const w of[...tcpW,...kernW])allWarnings.push({host:h.name,param:w.label,warning:w.warning,sapNote:w.sapNote})
  }
  if(allWarnings.length){html+=`<div class="card warn-card" style="border-color:#FAAD14;"><div class="card-title" style="color:#AD6800;">⚠️ SAP Note Compliance Warnings <span class="tag tag-warn">${allWarnings.length}</span></div><div class="card-body"><div class="data-table-wrap"><table class="data-table"><thead><tr><th>Host</th><th>Parameter</th><th>Warning</th><th>SAP Note</th></tr></thead><tbody>`;for(const w of allWarnings)html+=`<tr><td>${tag('tag-cyan',w.host)}</td><td><code style="font-size:11px;">${escHtml(w.param)}</code></td><td style="color:#AD6800;font-size:11px;">${escHtml(w.warning)}</td><td><a href="https://me.sap.com/notes/${encodeURIComponent(w.sapNote)}" target="_blank" style="font-size:11px;">${escHtml(w.sapNote)}</a></td></tr>`;html+='</tbody></table></div></div></div>'}

  if(mixed&&hostVersions.length){
    html+=`<div class="card"><div class="card-title">HANA Version per Host ${tag('tag-warn','Mixed versions detected')}</div><div class="card-body"><table class="data-table"><thead><tr><th>Host</th><th>HANA Version</th></tr></thead><tbody>`
    for(const h of hostVersions){const isOther=h.v!==uniqueVers[0];html+=`<tr><td>${tag(h.host===data.activeMaster?'tag-green':'tag-cyan',h.host)}</td><td><span class="mono" style="${isOther?'color:#D46B08;font-weight:600;':''}">${escHtml(h.v)}</span></td></tr>`}
    html+='</tbody></table></div></div>'
  }
  if(mixedOS&&hostOS.length){
    html+=`<div class="card"><div class="card-title">OS per Host ${tag('tag-warn','Mixed OS detected')}</div><div class="card-body"><table class="data-table"><thead><tr><th>Host</th><th>OS</th></tr></thead><tbody>`
    for(const h of hostOS){const isOther=h.v!==uniqueOS[0];html+=`<tr><td>${tag('tag-cyan',h.host)}</td><td><span class="mono" style="${isOther?'color:#D46B08;font-weight:600;':''}">${escHtml(h.v)}</span></td></tr>`}
    html+='</tbody></table></div></div>'
  }
  if(mixedKernel&&hostKernel.length){
    html+=`<div class="card"><div class="card-title">Kernel Version per Host ${tag('tag-warn','Mixed kernel versions detected')}</div><div class="card-body"><table class="data-table"><thead><tr><th>Host</th><th>Kernel Version</th></tr></thead><tbody>`
    for(const h of hostKernel){const isOther=h.v!==uniqueKernel[0];html+=`<tr><td>${tag('tag-cyan',h.host)}</td><td><span class="mono" style="${isOther?'color:#D46B08;font-weight:600;':''}">${escHtml(h.v)}</span></td></tr>`}
    html+='</tbody></table></div></div>'
  }
  if(mixedInst&&hostInst.length){
    html+=`<div class="card"><div class="card-title">Instance per Host ${tag('tag-warn','Mixed instances detected')}</div><div class="card-body"><table class="data-table"><thead><tr><th>Host</th><th>Instance</th></tr></thead><tbody>`
    for(const h of hostInst){const isOther=h.v!==uniqueInst[0];html+=`<tr><td>${tag('tag-cyan',h.host)}</td><td><span class="mono" style="${isOther?'color:#D46B08;font-weight:600;':''}">${escHtml(h.v)}</span></td></tr>`}
    html+='</tbody></table></div></div>'
  }
  return html
}

function renderTreeNode(node,depth){const hasChildren=node.children&&node.children.length>0;const id='tn-'+node.key;return `<div class="tree-node" id="${id}"><div class="tree-node-label" onclick="toggleTree('${id}')" style="padding-left:${depth*14}px"><span class="tree-toggle">${hasChildren?'&#9654;':''}</span><span class="tree-text">${escHtml(node.title)}</span></div>${hasChildren?`<div class="tree-children collapsed">${node.children.map(c=>renderTreeNode(c,depth+1)).join('')}</div>`:''}</div>`}
function toggleTree(id){const el=document.getElementById(id);if(!el)return;const ch=el.querySelector(':scope > .tree-children');if(!ch)return;ch.classList.toggle('collapsed');const arrow=el.querySelector(':scope > .tree-node-label .tree-toggle');if(arrow)arrow.style.transform=ch.classList.contains('collapsed')?'':'rotate(90deg)'}
function applyTreeSearch(text){const lower=text.toLowerCase().trim();document.querySelectorAll('#rawTree .tree-node').forEach(node=>{const lbl=node.querySelector(':scope > .tree-node-label .tree-text');if(!lbl)return;if(!lbl.getAttribute('data-orig'))lbl.setAttribute('data-orig',lbl.textContent);lbl.innerHTML=escHtml(lbl.getAttribute('data-orig'))});if(!lower){document.querySelectorAll('#rawTree .tree-node').forEach(n=>n.style.display='');document.querySelectorAll('#rawTree .tree-children').forEach(c=>c.classList.add('collapsed'));return}const matchSet=new Set();document.querySelectorAll('#rawTree .tree-node').forEach(node=>{const lbl=node.querySelector(':scope > .tree-node-label .tree-text');if(!lbl)return;const orig=lbl.getAttribute('data-orig')||'';if(orig.toLowerCase().includes(lower))matchSet.add(node.id)});const visibleSet=new Set(matchSet);matchSet.forEach(id=>{let el=document.getElementById(id);while(el){el=el.parentElement?.closest('.tree-node');if(el)visibleSet.add(el.id)}});document.querySelectorAll('#rawTree .tree-node').forEach(node=>{if(!visibleSet.has(node.id)){node.style.display='none';return}node.style.display='';const ch=node.querySelector(':scope > .tree-children');if(ch)ch.classList.remove('collapsed');const lbl=node.querySelector(':scope > .tree-node-label .tree-text');if(lbl&&matchSet.has(node.id)){const orig=lbl.getAttribute('data-orig')||'';const idx=orig.toLowerCase().indexOf(lower);if(idx>=0)lbl.innerHTML=escHtml(orig.substring(0,idx))+`<mark class="hl">${escHtml(orig.substring(idx,idx+lower.length))}</mark>`+escHtml(orig.substring(idx+lower.length))}})}

function toggleCollapse(id){const el=document.getElementById(id);if(el)el.classList.toggle('open')}

function switchNsPort(cid,port){
  const tabsEl=document.getElementById(cid+'-tabs')
  if(tabsEl) tabsEl.querySelectorAll('button[data-port]').forEach(b=>{
    const a=b.dataset.port===port
    b.style.color=a?'#0078D4':'#605E5C';b.style.borderBottom=a?'2px solid #0078D4':'2px solid transparent'
    b.style.fontWeight=a?'600':'normal';b.style.background=a?'#EFF6FC':'transparent'
  })
  const contentEl=document.getElementById(cid+'-content')
  if(!contentEl)return
  const d=(window._nsData||{})[cid];if(!d)return

  // init page offset per port
  if(!d._portOffset)d._portOffset={}
  if(d._portOffset[port]===undefined)d._portOffset[port]=0  // 0 = latest

  renderNsPortContent(cid,port)
}

function nsPageRows(cid,port){
  const d=window._nsData[cid];if(!d)return[]
  const all=d._allByPort[port]||[];const PAGE=500
  const offset=d._portOffset[port]||0
  const end=all.length-offset
  const start=Math.max(0,end-PAGE)
  return all.slice(start,end)
}

function renderNsPortContent(cid,port){
  const d=window._nsData[cid];if(!d)return
  const contentEl=document.getElementById(cid+'-content');if(!contentEl)return
  const all=d._allByPort[port]||[];const PAGE=500
  const offset=d._portOffset[port]||0
  const end=all.length-offset;const start=Math.max(0,end-PAGE)
  const rows=all.slice(start,end)
  const total=all.length
  const headers=d.headers,iHost=d.iHost,iPort=d.iPort,iTime=d.iTime
  const dispHeaders=headers.map(h=>h.replace(/\s*\[.*?\]/,'').trim())
  const innerId=cid+'-'+port.replace(/[^a-z0-9]/gi,'-')

  function fmtVal(v){if(v===null||v===undefined)return '';const n=parseFloat(v);return isNaN(n)?String(v):n.toLocaleString()}
  function fmtTime(ts){if(ts===null||ts===undefined)return '-';const n=parseFloat(ts);if(isNaN(n)||n<=0)return '-';return new Date(n*1000).toLocaleString()}

  const canPrev=end>PAGE;const canNext=offset>0
  const fromRow=start+1;const toRow=end

  let html=`
  <div style="display:flex;align-items:center;gap:8px;padding:6px 12px;font-size:11px;color:#605E5C;border-bottom:1px solid #EDEBE9;background:#F8F8F7;flex-wrap:wrap;">
    <span>Rows <strong>${fromRow.toLocaleString()}–${toRow.toLocaleString()}</strong> of <strong>${total.toLocaleString()}</strong></span>
    <button class="btn-sm" ${canPrev?'':'disabled style="opacity:0.4;cursor:default;"'} onclick="nsPagePrev('${cid}','${port}')">◀ Previous 500</button>
    <button class="btn-sm" ${canNext?'':'disabled style="opacity:0.4;cursor:default;"'} onclick="nsPageNext('${cid}','${port}')">Next 500 ▶</button>
  </div>
  <div id="${innerId}-itabs" style="display:flex;border-bottom:1px solid #EDEBE9;background:#fff;padding:0 12px;">
    <button data-inner="chart-cpu"  onclick="switchNsInner('${innerId}','chart-cpu')"  style="display:inline-flex;align-items:center;height:30px;padding:0 12px;border:none;border-bottom:2px solid transparent;background:transparent;font-family:inherit;font-size:11px;color:#605E5C;cursor:pointer;">📈 Chart - CPU</button>
    <button data-inner="chart-mem"  onclick="switchNsInner('${innerId}','chart-mem')"  style="display:inline-flex;align-items:center;height:30px;padding:0 12px;border:none;border-bottom:2px solid transparent;background:transparent;font-family:inherit;font-size:11px;color:#605E5C;cursor:pointer;">📈 Chart - Memory</button>
    <button data-inner="chart-sql"  onclick="switchNsInner('${innerId}','chart-sql')"  style="display:inline-flex;align-items:center;height:30px;padding:0 12px;border:none;border-bottom:2px solid transparent;background:transparent;font-family:inherit;font-size:11px;color:#605E5C;cursor:pointer;">📈 Chart - SQL Statements</button>
    <button data-inner="table"      onclick="switchNsInner('${innerId}','table')"      style="display:inline-flex;align-items:center;height:30px;padding:0 12px;border:none;border-bottom:2px solid transparent;background:transparent;font-family:inherit;font-size:11px;color:#605E5C;cursor:pointer;">📋 Table</button>
  </div>
  <!-- shared time controls (used by all chart tabs) -->
  <div id="${innerId}-timecontrols" style="display:none;padding:8px 8px 0 8px;">
    <div style="display:flex;align-items:center;gap:10px;font-size:11px;color:#605E5C;margin-bottom:4px;flex-wrap:wrap;">
      <span>Window:</span>
      <select id="${innerId}-winsel" onchange="redrawNsChart('${innerId}','${cid}')" style="height:24px;padding:0 6px;border:1px solid #EDEBE9;border-radius:2px;font-family:inherit;font-size:11px;">
        <option value="1800">30 min</option>
        <option value="3600" selected>1 hour</option>
        <option value="5400">1.5 hours</option>
        <option value="7200">2 hours</option>
      </select>
      <input type="range" id="${innerId}-slider" min="0" max="100" value="100" style="width:280px;vertical-align:middle;" oninput="redrawNsChart('${innerId}','${cid}')">
      <strong id="${innerId}-win-label" style="font-size:11px;color:#323130;"></strong>
    </div>
  </div>
  <div id="${innerId}-chart-cpu" style="display:none;padding:0 8px 8px 8px;">
    <canvas id="${innerId}-canvas-cpu" style="width:100%;height:220px;display:block;"></canvas>
    <div style="font-size:12px;color:#605E5C;margin-top:4px;">
      <span style="color:#0078D4;font-size:14px;">━</span> indexserverCpu &nbsp;&nbsp;
      <span style="color:#D46B08;font-size:14px;">━</span> indexserverCpuSys
    </div>
  </div>
  <div id="${innerId}-chart-mem" style="display:none;padding:0 8px 8px 8px;">
    <canvas id="${innerId}-canvas-mem" style="width:100%;height:220px;display:block;"></canvas>
    <div style="font-size:12px;color:#605E5C;margin-top:4px;">
      <span style="color:#389E0D;font-size:14px;">━</span> indexserverMemUsed &nbsp;&nbsp;
      <span style="color:#A19F9D;font-size:14px;">━</span> indexserverMemLimit
    </div>
  </div>
  <div id="${innerId}-chart-sql" style="display:none;padding:0 8px 8px 8px;">
    <canvas id="${innerId}-canvas-sql" style="width:100%;height:220px;display:block;"></canvas>
    <div style="font-size:12px;color:#605E5C;margin-top:4px;">
      <span style="color:#722ED1;font-size:14px;">━</span> sqlStatements
    </div>
  </div>
  <div id="${innerId}-table" style="display:none;overflow-x:auto;max-height:calc(100vh - 340px);overflow-y:auto;">
    <table class="data-table" style="white-space:nowrap;width:auto;min-width:100%;">
    <thead style="position:sticky;top:0;z-index:5;"><tr><th>Time</th>`
  for(let i=0;i<headers.length;i++){if(i===iHost||i===iPort||i===iTime)continue;html+=`<th title="${escHtml(headers[i])}">${escHtml(dispHeaders[i])}</th>`}
  html+=`</tr></thead><tbody>`
  for(const r of rows){
    html+=`<tr><td><span class="mono" style="font-size:11px;">${escHtml(fmtTime(r.time))}</span></td>`
    for(let i=0;i<headers.length;i++){if(i===iHost||i===iPort||i===iTime)continue;html+=`<td><span class="mono">${escHtml(fmtVal(r.row[i]))}</span></td>`}
    html+=`</tr>`
  }
  html+=`</tbody></table></div>`
  contentEl.innerHTML=html

  // store current rows for chart — keyed by innerId (not port) to avoid cross-host collision
  window._nsData[cid]._portRows[innerId]=rows

  // restore previously active chart tab, default to chart-cpu
  const activeTab=(d._activeTab&&d._activeTab[port])||'chart-cpu'
  switchNsInner(innerId,activeTab)
}

function nsPagePrev(cid,port){
  const d=window._nsData[cid];if(!d)return
  const all=d._allByPort[port]||[];const PAGE=500
  const offset=d._portOffset[port]||0
  const end=all.length-offset;const newEnd=Math.max(PAGE,end-PAGE)
  d._portOffset[port]=all.length-newEnd
  renderNsPortContent(cid,port)
}

function nsPageNext(cid,port){
  const d=window._nsData[cid];if(!d)return
  if(!d._portOffset)d._portOffset={}
  d._portOffset[port]=Math.max(0,(d._portOffset[port]||0)-500)
  renderNsPortContent(cid,port)
}

function switchNsInner(innerId,tab){
  // persist active tab per port so paging restores it
  for(const cid of Object.keys(window._nsData||{})){
    const d=window._nsData[cid];if(!d._portRows)continue
    if(d._portRows[innerId]){
      if(!d._activeTab)d._activeTab={}
      // derive port from innerId: innerId = cid + '-' + port-safe
      for(const p of Object.keys(d._allByPort)){
        if(cid+'-'+p.replace(/[^a-z0-9]/gi,'-')===innerId){d._activeTab[p]=tab;break}
      }
      break
    }
  }
  const itabs=document.getElementById(innerId+'-itabs')
  if(itabs) itabs.querySelectorAll('button[data-inner]').forEach(b=>{
    const a=b.dataset.inner===tab
    b.style.color=a?'#0078D4':'#605E5C';b.style.borderBottom=a?'2px solid #0078D4':'2px solid transparent'
    b.style.fontWeight=a?'600':'normal';b.style.background=a?'#EFF6FC':'transparent'
  })
  const isChart=tab.startsWith('chart-')
  const timeControls=document.getElementById(innerId+'-timecontrols')
  if(timeControls)timeControls.style.display=isChart?'block':'none'
  // hide all chart canvases and table
  for(const t of['chart-cpu','chart-mem','chart-sql','table']){
    const el=document.getElementById(innerId+'-'+t)
    if(el)el.style.display='none'
  }
  const target=document.getElementById(innerId+'-'+tab)
  if(target)target.style.display='block'
  if(isChart) requestAnimationFrame(()=>{
    for(const cid of Object.keys(window._nsData||{})){
      const d=window._nsData[cid];if(!d._portRows)continue
      if(d._portRows[innerId]){drawNsChart(innerId,cid,tab);return}
    }
  })
}

function redrawNsChart(innerId,cid){
  // find which chart tab is currently visible and redraw it
  for(const t of['chart-cpu','chart-mem','chart-sql']){
    const el=document.getElementById(innerId+'-'+t)
    if(el&&el.style.display!=='none'){drawNsChart(innerId,cid,t);return}
  }
}

function drawNsChart(innerId,cid,chartType){
  if(!chartType)chartType='chart-cpu'
  const canvasId=innerId+'-canvas-'+chartType.replace('chart-','')
  const canvas=document.getElementById(canvasId);if(!canvas)return
  const d=(window._nsData||{})[cid];if(!d)return
  const rows=d._portRows[innerId];if(!rows||!rows.length)return

  // define series per chart type
  const SERIES={
    'chart-cpu':[
      {col:'indexserverCpu',    color:'#0078D4', label:'indexserverCpu'},
      {col:'indexserverCpuSys', color:'#D46B08', label:'indexserverCpuSys'},
    ],
    'chart-mem':[
      {col:'indexserverMemUsed',  color:'#389E0D', label:'indexserverMemUsed'},
      {col:'indexserverMemLimit', color:'#A19F9D', label:'indexserverMemLimit'},
    ],
    'chart-sql':[
      {col:'sqlStatements', color:'#722ED1', label:'sqlStatements'},
    ],
  }
  const series=SERIES[chartType]||SERIES['chart-cpu']
  const colIndices=series.map(s=>({...s,idx:d.COL[s.col]??-1})).filter(s=>s.idx>=0)
  if(!colIndices.length)return

  const isMem=chartType==='chart-mem'

  const selEl=document.getElementById(innerId+'-winsel')
  const WINDOW_SECS=selEl?parseInt(selEl.value):3600
  const slider=document.getElementById(innerId+'-slider')
  const pct=slider?parseFloat(slider.value)/100:1

  const times=rows.map(r=>parseFloat(r.time)).filter(t=>!isNaN(t))
  if(!times.length)return
  const tMin=times[0],tMax=times[times.length-1]
  const tEnd=tMin+pct*(tMax-tMin)
  const tStart=Math.max(tMin,tEnd-WINDOW_SECS)
  const tEndC=Math.min(tMax,tStart+WINDOW_SECS)

  const lbl=document.getElementById(innerId+'-win-label')
  if(lbl) lbl.textContent=`${new Date(tStart*1000).toLocaleString()} – ${new Date(tEndC*1000).toLocaleString()}`

  const visible=rows.filter(r=>{const t=parseFloat(r.time);return t>=tStart&&t<=tEndC})
  if(!visible.length)return

  canvas.width=canvas.offsetWidth||800;canvas.height=220
  const W=canvas.width,H=canvas.height
  const PAD={top:16,right:20,bottom:30,left:isMem?72:46}
  const cw=W-PAD.left-PAD.right,ch=H-PAD.top-PAD.bottom
  const ctx=canvas.getContext('2d');ctx.clearRect(0,0,W,H)

  const allVals=colIndices.flatMap(s=>visible.map(r=>parseFloat(r.row[s.idx])).filter(v=>!isNaN(v)&&v>=0))
  if(!allVals.length)return
  const vMax=Math.max(...allVals,1),vMin=0
  const tx=t=>PAD.left+(t-tStart)/(tEndC-tStart)*cw
  const ty=v=>PAD.top+(1-(v-vMin)/(vMax-vMin))*ch

  function fmtYLabel(v){if(isMem){if(v>=1073741824)return(v/1073741824).toFixed(1)+'G';if(v>=1048576)return(v/1048576).toFixed(1)+'M';if(v>=1024)return(v/1024).toFixed(1)+'K';return v}return v.toFixed(v<10?1:0)}

  // grid + y-labels
  ctx.strokeStyle='#EDEBE9';ctx.lineWidth=1
  for(let i=0;i<=5;i++){
    const v=vMin+(vMax-vMin)*i/5,y=ty(v)
    ctx.beginPath();ctx.moveTo(PAD.left,y);ctx.lineTo(PAD.left+cw,y);ctx.stroke()
    ctx.fillStyle='#A19F9D';ctx.font='10px Segoe UI,sans-serif';ctx.textAlign='right';ctx.textBaseline='middle'
    ctx.fillText(fmtYLabel(v),PAD.left-4,y)
  }
  // x-labels
  ctx.fillStyle='#A19F9D';ctx.font='9px Segoe UI,sans-serif';ctx.textAlign='center';ctx.textBaseline='top'
  for(let i=0;i<=6;i++){
    const t=tStart+(tEndC-tStart)*i/6
    ctx.fillText(new Date(t*1000).toLocaleTimeString([],{hour:'2-digit',minute:'2-digit',second:'2-digit'}),tx(t),PAD.top+ch+4)
  }
  // lines
  for(const s of colIndices){
    ctx.strokeStyle=s.color;ctx.lineWidth=1.5;ctx.beginPath();let first=true
    for(const r of visible){
      const t=parseFloat(r.time),v=parseFloat(r.row[s.idx])
      if(isNaN(t)||isNaN(v)||v<0)continue
      first?ctx.moveTo(tx(t),ty(v)):ctx.lineTo(tx(t),ty(v));first=false
    }
    ctx.stroke()
  }
}

function expandAll(panelId){document.querySelectorAll(`[id^="${panelId}-"]`).forEach(el=>{if(el.classList.contains('collapse-panel'))el.classList.add('open')})}
function collapseAll(panelId){document.querySelectorAll(`[id^="${panelId}-"]`).forEach(el=>{if(el.classList.contains('collapse-panel'))el.classList.remove('open')})}

function renderVersionHistory(text){
  const lines=text.split('\n').map(l=>l.trim()).filter(l=>l)
  if(lines.length<2)return `<div class="not-found-msg"><span class="nf-icon">⚠️</span><span>versionhistory.csv is empty or invalid.</span></div>`
  const headers=lines[0].split(';');const rows=lines.slice(1).map(l=>l.split(';'))
  let html=`<div class="card"><div class="card-title">📋 Version History <span style="font-weight:400;font-size:11px;color:#605E5C;">SYS/global/hdb/versionhistory.csv</span></div><div class="card-body"><div class="data-table-wrap"><table class="data-table"><thead><tr>`
  for(const h of headers)html+=`<th>${escHtml(h)}</th>`
  html+=`</tr></thead><tbody>`
  for(const row of rows){html+=`<tr>`;for(let i=0;i<headers.length;i++){const val=row[i]||'';if(headers[i]==='version')html+=`<td>${tag('tag-blue',val)}</td>`;else if(headers[i]==='branch')html+=`<td>${tag('tag-cyan',val)}</td>`;else html+=`<td><span class="mono">${escHtml(val)}</span></td>`}html+=`</tr>`}
  html+=`</tbody></table></div></div></div>`
  return html
}


function parseRefIni(text){
  // returns { sectionName -> { paramKey -> {shortDesc,fullDesc,type,unit,range,change,defaultValue} } }
  const result={}
  const lines=text.split('\n').map(l=>l.replace(/\r$/,''))
  let curSection=null
  let pendingMeta={shortDesc:[],fullDesc:[],type:'',unit:'',range:'',change:'',inFull:false}

  function resetMeta(){return{shortDesc:[],fullDesc:[],type:'',unit:'',range:'',change:'',inFull:false}}

  for(const line of lines){
    const t=line.trim()
    // section header
    if(t.startsWith('[')&&t.endsWith(']')){curSection=t.slice(1,-1);if(!result[curSection])result[curSection]={};pendingMeta=resetMeta();continue}
    // comment lines — parse meta tags
    if(t.startsWith('#')){
      const c=t.replace(/^#\s?/,'')
      if(c.startsWith('.short_desc')){pendingMeta.inFull=false;continue}
      if(c.startsWith('.full_desc')){pendingMeta.inFull=true;continue}
      if(c.startsWith('.type ')){pendingMeta.type=c.replace('.type ','').trim();pendingMeta.inFull=false;continue}
      if(c.startsWith('.unit ')){pendingMeta.unit=c.replace('.unit ','').trim();pendingMeta.inFull=false;continue}
      if(c.startsWith('.range ')){pendingMeta.range=c.replace('.range ','').trim();pendingMeta.inFull=false;continue}
      if(c.startsWith('.change ')){pendingMeta.change=c.replace('.change ','').trim();pendingMeta.inFull=false;continue}
      if(c.startsWith('.')){pendingMeta.inFull=false;continue}
      // accumulate short_desc (first non-tag line after #)
      if(!pendingMeta.inFull&&pendingMeta.shortDesc.length===0&&c.trim())pendingMeta.shortDesc.push(c.trim())
      // accumulate full_desc
      if(pendingMeta.inFull)pendingMeta.fullDesc.push(c)
      continue
    }
    // blank line resets full_desc accumulation but keeps meta until we hit a key=value
    if(!t){pendingMeta.inFull=false;continue}
    // key = value line (or key with no default value)
    const eq=t.indexOf('=')
    const key=eq!==-1?t.substring(0,eq).trim():t.trim()
    const defVal=eq!==-1?t.substring(eq+1).trim():''
    if(curSection&&key){
      // clean trailing empty lines from fullDesc
      while(pendingMeta.fullDesc.length&&!pendingMeta.fullDesc[pendingMeta.fullDesc.length-1].trim())pendingMeta.fullDesc.pop()
      result[curSection][key]={
        shortDesc:pendingMeta.shortDesc.join(' '),
        fullDesc:pendingMeta.fullDesc.join('\n').trim(),
        type:pendingMeta.type,
        unit:pendingMeta.unit,
        range:pendingMeta.range,
        change:pendingMeta.change,
        defaultValue:defVal
      }
      pendingMeta=resetMeta()
    }
  }
  return result
}

function renderIniFile(filename,text){
  const lines=text.split('\n').map(l=>l.replace(/\r$/,''))
  const ref=(configRefData[filename])||{}
  const hasAnyRef=Object.keys(ref).length>0

  // parse all sections first
  const sections=[]
  let curSection=null,curRows=[]
  for(const line of lines){
    const t=line.trim()
    if(!t||t.startsWith('#'))continue
    if(t.startsWith('[')&&t.endsWith(']')){
      if(curSection!==null)sections.push({name:curSection,rows:curRows})
      curSection=t.slice(1,-1);curRows=[]
    } else if(curSection!==null){
      const eq=t.indexOf('=')
      if(eq!==-1)curRows.push([t.substring(0,eq).trim(),t.substring(eq+1).trim()])
    }
  }
  if(curSection!==null)sections.push({name:curSection,rows:curRows})

  const refLabel=hasAnyRef
    ?'<span style="font-size:10px;font-weight:400;color:#389E0D;margin-left:6px;">✓ reference data available</span>'
    :'<span style="font-size:10px;font-weight:400;color:#A19F9D;margin-left:6px;">no reference data</span>'

  let html=`<div class="card" style="margin-bottom:18px;">
    <div class="card-title">📄 ${escHtml(filename)} ${refLabel}</div>
    <div class="card-body" style="padding:0;overflow-x:auto;">
    <table class="data-table" style="table-layout:auto;width:${hasAnyRef?'100%':'auto'};min-width:400px;">
    <colgroup>
      <col style="white-space:nowrap;">
      <col style="white-space:nowrap;">
      ${hasAnyRef?'<col style="white-space:nowrap;"><col style="width:70px;"><col style="width:70px;"><col style="width:90px;"><col style="width:70px;"><col>':''}
    </colgroup>
    <thead><tr>
      <th style="white-space:nowrap;">Parameter</th><th style="white-space:nowrap;">Value</th>
      ${hasAnyRef?'<th style="white-space:nowrap;">Default</th><th>Type</th><th>Unit</th><th>Range</th><th>Change</th><th>Description</th>':''}
    </tr></thead><tbody>`

  for(const sec of sections){
    // section header row
    html+=`<tr><td colspan="${hasAnyRef?8:2}" style="background:#EFF6FF;color:#0078D4;font-weight:600;font-size:11px;padding:5px 12px;border-bottom:1px solid #BAD7FF;">[${escHtml(sec.name)}]</td></tr>`
    for(const[k,v]of sec.rows){
      const m=ref[sec.name]?.[k]
      const isModified=m&&v.trim()!==m.defaultValue.trim()
      const valStyle=isModified?'color:#D46B08;font-weight:600;':''
      if(hasAnyRef){
        html+=`<tr>
          <td style="white-space:nowrap;"><span class="mono" style="font-weight:600;">${escHtml(k)}</span></td>
          <td style="white-space:nowrap;"><span class="mono" style="${valStyle}">${escHtml(v)}</span></td>
          <td style="white-space:nowrap;"><span class="mono" style="color:#A19F9D;">${escHtml(m?.defaultValue||'-')}</span></td>
          <td>${m?.type?`<span class="tag tag-blue" style="white-space:nowrap;">${escHtml(m.type)}</span>`:'-'}</td>
          <td>${m?.unit?`<span class="mono">${escHtml(m.unit)}</span>`:'-'}</td>
          <td><span class="mono">${escHtml(m?.range||'-')}</span></td>
          <td>${m?.change?`<span class="tag ${m.change==='online'?'tag-green':m.change==='offline'?'tag-orange':'tag-cyan'}" style="white-space:nowrap;">${escHtml(m.change)}</span>`:'-'}</td>
          <td style="font-size:11px;color:#605E5C;white-space:normal;min-width:200px;">${m?.shortDesc?`<strong>${escHtml(m.shortDesc)}</strong>`:''}${m?.fullDesc?`<br><span style="color:#A19F9D;white-space:pre-wrap;">${escHtml(m.fullDesc)}</span>`:''}</td>
        </tr>`
      } else {
        html+=`<tr>
          <td style="white-space:nowrap;"><span class="mono" style="font-weight:600;">${escHtml(k)}</span></td>
          <td style="white-space:nowrap;word-break:break-all;"><span class="mono" style="${valStyle}">${escHtml(v)}</span></td>
        </tr>`
      }
    }
  }
  html+=`</tbody></table></div></div>`
  return html
}

// ============================================================
// CANVAS
// ============================================================
function drawTopology(data){
  const canvas=document.getElementById('topo-canvas');if(!canvas)return
  canvas._topoData=data;canvas.width=canvas.offsetWidth||900;canvas.height=200
  const ctx=canvas.getContext('2d');ctx.clearRect(0,0,canvas.width,canvas.height)
  const rows=data.replicationRowsMain||data.replicationRows||[],hosts=data.hosts||[],hasHSR=rows.length>0
  const siteMap={}
  for(const r of rows){if(!siteMap[r.primarySiteId])siteMap[r.primarySiteId]={id:r.primarySiteId,name:r.primarySiteName,hosts:new Set()};if(!siteMap[r.secondarySiteId])siteMap[r.secondarySiteId]={id:r.secondarySiteId,name:r.secondarySiteName,hosts:new Set()};siteMap[r.primarySiteId].hosts.add(r.primaryHost);siteMap[r.secondarySiteId].hosts.add(r.secondaryHost)}
  if(!hasHSR&&hosts.length)siteMap[1]={id:1,name:data.systemSID||'PRIMARY',hosts:new Set(hosts.map(h=>h.name))}
  const sites=Object.values(siteMap).sort((a,b)=>a.id-b.id)
  const edgeMap={}
  for(const r of rows){const k=`${r.primarySiteId}->${r.secondarySiteId}`;if(!edgeMap[k])edgeMap[k]={from:r.primarySiteId,to:r.secondarySiteId,mode:r.replicationMode,opmode:r.operationMode||''}}
  const edges=Object.values(edgeMap)
  const W=canvas.width,PAD=40,COL_GAP=110,ROW_GAP=30,HOST_W=110,HOST_H=60,SITE_PAD=16,SITE_TITLE_H=28
  function siteBoxSize(site){const n=site.hosts.size||1,cols2=Math.ceil(Math.sqrt(n)),rows2=Math.ceil(n/cols2);return{w:cols2*(HOST_W+10)+SITE_PAD*2-10,h:rows2*(HOST_H+10)+SITE_PAD*2+SITE_TITLE_H-10}}
  const inDeg={};for(const s of sites)inDeg[s.id]=0;for(const e of edges)inDeg[e.to]++
  const roots=sites.filter(s=>inDeg[s.id]===0)
  const colLevel={};for(const s of sites)colLevel[s.id]=0
  const bfsQ=[...(roots.length?roots:[sites[0]]).map(s=>s.id)],bfsVis=new Set(bfsQ)
  while(bfsQ.length){const id=bfsQ.shift();for(const e of edges){if(e.from!==id)continue;colLevel[e.to]=Math.max(colLevel[e.to]||0,colLevel[id]+1);if(!bfsVis.has(e.to)){bfsVis.add(e.to);bfsQ.push(e.to)}}}
  const maxCol=Math.max(...sites.map(s=>colLevel[s.id]))
  const columns=[];for(let c=0;c<=maxCol;c++)columns.push(sites.filter(s=>colLevel[s.id]===c).sort((a,b)=>a.id-b.id))
  const colWidths=columns.map(col=>Math.max(...col.map(s=>siteBoxSize(s).w)))
  const colHeights=columns.map(col=>col.reduce((a,s)=>a+siteBoxSize(s).h+ROW_GAP,-ROW_GAP))
  const maxColH=Math.max(...colHeights)
  canvas.height=Math.max(maxColH+PAD*2+50,180);ctx.clearRect(0,0,canvas.width,canvas.height)
  const totalW=colWidths.reduce((a,w)=>a+w+COL_GAP,-COL_GAP),startX=Math.max(PAD,(W-totalW)/2)
  const posMap={};let cx=startX
  for(let c=0;c<=maxCol;c++){const col=columns[c],colH=colHeights[c];let cy=PAD+(maxColH-colH)/2;for(const s of col){const sz=siteBoxSize(s);posMap[s.id]={x:cx+(colWidths[c]-sz.w)/2,y:cy,...sz};cy+=sz.h+ROW_GAP}cx+=colWidths[c]+COL_GAP}
  const MODE_COLOR={SYNC:'#389E0D',ASYNC:'#1677FF',SYNCMEM:'#722ED1',PRIMARY:'#0078D4'}
  function siteCenter(p){return{x:p.x+p.w/2,y:p.y+p.h/2}}
  function roundRect(c,x,y,w,h,r){c.beginPath();c.moveTo(x+r,y);c.lineTo(x+w-r,y);c.arcTo(x+w,y,x+w,y+r,r);c.lineTo(x+w,y+h-r);c.arcTo(x+w,y+h,x+w-r,y+h,r);c.lineTo(x+r,y+h);c.arcTo(x,y+h,x,y+h-r,r);c.lineTo(x,y+r);c.arcTo(x,y,x+r,y,r);c.closePath()}
  function boxEdgePoint(box,cx,cy,tx,ty){const dx=tx-cx,dy=ty-cy;if(Math.abs(dx)<0.001&&Math.abs(dy)<0.001)return{x:cx,y:cy};const sX=dx!==0?(box.w/2)/Math.abs(dx):Infinity,sY=dy!==0?(box.h/2)/Math.abs(dy):Infinity,scale=Math.min(sX,sY);return{x:cx+dx*scale,y:cy+dy*scale}}
  function drawArrow(x1,y1,x2,y2,color,label){const dx=x2-x1,dy=y2-y1,len=Math.sqrt(dx*dx+dy*dy);if(len<1)return;const ux=dx/len,uy=dy/len,margin=18,sx=x1+ux*margin,sy=y1+uy*margin,ex=x2-ux*margin,ey=y2-uy*margin;ctx.save();ctx.strokeStyle=color;ctx.fillStyle=color;ctx.lineWidth=2.5;ctx.beginPath();ctx.moveTo(sx,sy);ctx.lineTo(ex,ey);ctx.stroke();const aLen=12,aW=6;ctx.beginPath();ctx.moveTo(ex,ey);ctx.lineTo(ex-ux*aLen+uy*aW,ey-uy*aLen-ux*aW);ctx.lineTo(ex-ux*aLen-uy*aW,ey-uy*aLen+ux*aW);ctx.closePath();ctx.fill();if(label){const mx=(sx+ex)/2,my=(sy+ey)/2,perpX=-uy*18,perpY=ux*18,lns=label.split('\n'),lineH=13;ctx.font='bold 10px Segoe UI,sans-serif';ctx.textAlign='center';ctx.textBaseline='middle';const tw=Math.max(...lns.map(l=>ctx.measureText(l).width))+12,th=lns.length*lineH+6;ctx.fillStyle='#fff';ctx.strokeStyle=color;ctx.lineWidth=1.5;roundRect(ctx,mx+perpX-tw/2,my+perpY-th/2,tw,th,4);ctx.fill();ctx.stroke();ctx.fillStyle=color;lns.forEach((ln,i)=>{const ly=my+perpY-((lns.length-1)*lineH/2)+i*lineH;ctx.fillText(ln,mx+perpX,ly)})}ctx.restore()}
  for(const e of edges){const p=posMap[e.from],q=posMap[e.to];if(!p||!q)continue;const cp=siteCenter(p),cq=siteCenter(q),pt=boxEdgePoint(p,cp.x,cp.y,cq.x,cq.y),qt=boxEdgePoint(q,cq.x,cq.y,cp.x,cp.y),color=MODE_COLOR[e.mode]||'#A19F9D',lbl=e.opmode?`${e.mode}\n${e.opmode}`:e.mode;drawArrow(pt.x,pt.y,qt.x,qt.y,color,lbl)}
  const overlayItems=[]
  function drawHostBox(c,x,y,w,h,name,accent){c.save();c.fillStyle='#FFFFFF';c.strokeStyle='#EDEBE9';c.lineWidth=1;roundRect(c,x,y,w,h,5);c.fill();c.stroke();c.strokeStyle=accent;c.fillStyle=accent+'22';c.lineWidth=1.5;roundRect(c,x+8,y+(h-22)/2,22,22,3);c.fill();c.stroke();c.strokeStyle=accent;c.lineWidth=1;for(let i=1;i<=3;i++){const ly=y+(h-22)/2+(22/4)*i;c.beginPath();c.moveTo(x+12,ly);c.lineTo(x+26,ly);c.stroke()}c.fillStyle='#201F1E';c.font='600 10px Consolas,monospace';c.textAlign='left';c.textBaseline='middle';let lbl=name;while(c.measureText(lbl).width>w-38&&lbl.length>4)lbl=lbl.slice(0,-1);if(lbl!==name)lbl+='…';c.fillText(lbl,x+34,y+h/2);c.restore()}
  for(const site of sites){const p=posMap[site.id];if(!p)continue;const isPrimary=inDeg[site.id]===0;const borderColor=isPrimary?'#0078D4':(MODE_COLOR[edges.find(e=>e.to===site.id)?.mode]||'#A19F9D');ctx.save();ctx.fillStyle=isPrimary?'#EFF6FF':'#F9F0FF';ctx.strokeStyle=borderColor;ctx.lineWidth=2;roundRect(ctx,p.x,p.y,p.w,p.h,8);ctx.fill();ctx.stroke();ctx.fillStyle=borderColor;ctx.fillRect(p.x,p.y,p.w,SITE_TITLE_H);ctx.fillStyle='#fff';ctx.font='bold 12px Segoe UI,sans-serif';ctx.textAlign='center';ctx.textBaseline='middle';ctx.fillText(`Site ${site.id}: ${site.name}`,p.x+p.w/2,p.y+SITE_TITLE_H/2);const hostArr=[...site.hosts],cols=Math.max(1,Math.ceil(Math.sqrt(hostArr.length)));hostArr.forEach((hN,idx)=>{const col=idx%cols,row2=Math.floor(idx/cols),hx=p.x+SITE_PAD+col*(HOST_W+10),hy=p.y+SITE_TITLE_H+SITE_PAD+row2*(HOST_H+10);drawHostBox(ctx,hx,hy,HOST_W,HOST_H,hN,borderColor);overlayItems.push({x:hx,y:hy,w:HOST_W,h:HOST_H,label:hN})});ctx.restore()}
  // Legend
  const modes=[...new Set(edges.map(e=>e.mode))];if(!modes.length)modes.push('PRIMARY')
  const MODE_DESC={SYNC:'SYNC — synchronous (zero data loss)',ASYNC:'ASYNC — asynchronous (minimal overhead)',SYNCMEM:'SYNCMEM — sync memory, async disk',PRIMARY:'PRIMARY site'}
  const legendItems=modes.map(m=>({color:MODE_COLOR[m]||'#A19F9D',label:MODE_DESC[m]||m}))
  const lx=12,ly=canvas.height-14-legendItems.length*18
  ctx.save();ctx.fillStyle='rgba(255,255,255,0.88)';ctx.strokeStyle='#EDEBE9';ctx.lineWidth=1
  roundRect(ctx,lx-6,ly-8,240,legendItems.length*18+16,5);ctx.fill();ctx.stroke()
  legendItems.forEach((item,i)=>{
    const iy=ly+i*18+2
    ctx.strokeStyle=item.color;ctx.lineWidth=2;ctx.beginPath();ctx.moveTo(lx,iy+6);ctx.lineTo(lx+16,iy+6);ctx.stroke()
    ctx.fillStyle=item.color;ctx.beginPath();ctx.moveTo(lx+16,iy+6);ctx.lineTo(lx+10,iy+3);ctx.lineTo(lx+10,iy+9);ctx.closePath();ctx.fill()
    ctx.fillStyle='#323130';ctx.font='10px Segoe UI,sans-serif';ctx.textAlign='left';ctx.textBaseline='middle'
    ctx.fillText(item.label,lx+22,iy+7)
  })
  ctx.restore()

  const overlayDiv=document.getElementById('topo-overlays')
  if(overlayDiv){const sX=canvas.offsetWidth>0?canvas.width/canvas.offsetWidth:1,sY=canvas.offsetHeight>0?canvas.height/canvas.offsetHeight:1;overlayDiv.innerHTML='';overlayDiv.style.width=canvas.offsetWidth+'px';overlayDiv.style.height=canvas.offsetHeight+'px';for(const item of overlayItems){const span=document.createElement('span');span.textContent=item.label;span.style.cssText=`position:absolute;left:${(item.x+34)/sX}px;top:${(item.y+item.h/2-6)/sY}px;width:${(item.w-38)/sX}px;font:600 10px Consolas,monospace;color:transparent;user-select:text;cursor:text;white-space:nowrap;overflow:hidden;pointer-events:all;`;overlayDiv.appendChild(span)}}
}
window.addEventListener('resize',()=>{const canvas=document.getElementById('topo-canvas');if(canvas&&canvas._topoData)drawTopology(canvas._topoData)})

// ============================================================
// RUNTIME DUMPS
// ============================================================
function parseRteDumpFilename(fname){
  // split at '.rtedump.' to separate left (service_host.port) from right (datetime.seq.reason.trc)
  const idx=fname.indexOf('.rtedump.')
  if(idx===-1)return null
  const left=fname.substring(0,idx)
  const right=fname.substring(idx+9)  // skip '.rtedump.'

  // left: <service>_<virtualhost>.<port>
  const usIdx=left.indexOf('_')
  if(usIdx===-1)return null
  const serviceName=left.substring(0,usIdx)
  const hostPort=left.substring(usIdx+1)
  const dotIdx=hostPort.lastIndexOf('.')
  const virtualHost=dotIdx===-1?hostPort:hostPort.substring(0,dotIdx)
  const port=dotIdx===-1?'':hostPort.substring(dotIdx+1)

  // right: <datetime>.<seq>.<reason>.trc — remove trailing .trc first
  const remainder=right.endsWith('.trc')?right.slice(0,-4):right
  const parts=remainder.split('.')
  if(parts.length<3)return null
  const datetime=parts[0]
  const seq=parts[1]
  const reason=parts.slice(2).join('.')

  return{filename:fname,serviceName,virtualHost,port,datetime,reason,seq}
}

function parseRuntimeDumpFilename(fname){
  // Format: {Service}_{Host}_{Port}_runtimedump_{YYYY_MM_DD_HH_MM_SS}.trc
  const rtIdx = fname.toLowerCase().indexOf('_runtimedump_')
  if(rtIdx === -1) return null
  const left = fname.substring(0, rtIdx)
  const right = fname.substring(rtIdx + 13).replace(/\.trc$/i, '')
  const parts = left.split('_')
  if(parts.length < 2) return null
  const serviceName = parts[0]
  const maybePort = parts[parts.length - 1]
  const hasPort = /^\d{4,6}$/.test(maybePort)
  const virtualHost = (hasPort ? parts.slice(1, -1) : parts.slice(1)).join('_')
  const port = hasPort ? maybePort : ''
  // Normalize datetime from 2026_10_02_13_14_07 → 20261002-131407
  const dp = right.split('_')
  const datetime = dp.length === 6 ? dp[0]+dp[1]+dp[2]+'-'+dp[3]+dp[4]+dp[5] : right
  return {filename:fname, serviceName, virtualHost, port, datetime, reason:'runtimedump', seq:'0'}
}

function parseCrashDumpFilename(fname){
  const idx=fname.indexOf('.crashdump.')
  if(idx===-1)return null
  const left=fname.substring(0,idx)
  const right=fname.substring(idx+11)
  const usIdx=left.indexOf('_')
  if(usIdx===-1)return null
  const serviceName=left.substring(0,usIdx)
  const hostPort=left.substring(usIdx+1)
  const dotIdx=hostPort.lastIndexOf('.')
  const virtualHost=dotIdx>=0?hostPort.substring(0,dotIdx):hostPort
  const port=dotIdx>=0?hostPort.substring(dotIdx+1):''
  const parts=right.split('.')
  const datetime=parts[0]||''
  const seq=parts[1]||''
  return{filename:fname,serviceName,virtualHost,port,datetime,seq,reason:'crashdump'}
}

function renderRteDumpKnowledge(){
  const links=[
    {
      title:'SAP HANA SQL Reference Guide for SAP HANA Platform',
      section:'Monitoring Views',
      url:'https://help.sap.com/docs/SAP_HANA_PLATFORM/4fe29514fd584807ac9f2a04f6754767/d3c10d23e8334a35afa8d9bdbc102366.html?locale=en-US'
    },
    {
      title:'SAP HANA Cloud, SAP HANA Database SQL Reference Guide',
      section:'Monitoring Views',
      url:'https://help.sap.com/docs/hana-cloud-database/sap-hana-cloud-sap-hana-database-sql-reference-guide/monitoring-views?locale=en-US'
    },
  ]

  let html=`<div class="card"><div class="card-title">📚 Knowledge — Runtime Dumps</div><div class="card-body">
  <p style="font-size:12px;color:#605E5C;margin-bottom:14px;">Reference documentation and resources for SAP HANA Runtime Dumps and Monitoring Views.</p>
  <ul style="list-style:none;padding:0;margin:0;display:flex;flex-direction:column;gap:8px;">`

  for(const l of links){
    html+=`<li style="display:flex;align-items:flex-start;gap:10px;padding:10px 12px;border:1px solid #EDEBE9;border-radius:2px;background:#FAFAFA;">
      <span style="font-size:16px;flex-shrink:0;">🔗</span>
      <div>
        <div style="font-size:12px;font-weight:600;color:#323130;">${escHtml(l.title)}</div>
        <div style="font-size:11px;color:#605E5C;margin:2px 0 6px 0;">${escHtml(l.section)}</div>
        <a href="${escHtml(l.url)}" target="_blank" style="font-size:11px;color:#0078D4;word-break:break-all;">${escHtml(l.url)}</a>
      </div>
    </li>`
  }

  html+=`</ul></div></div>`
  return html
}

function renderRteDumps(dumps,scannedPaths){
  const count=dumps.length
  const pathList=scannedPaths.length
    ?scannedPaths.map(p=>`<code>${escHtml(p)}</code>`).join(', ')
    :'<span style="color:#A19F9D;">none</span>'
  let html=`<div style="margin-bottom:10px;position:relative;">
  <input id="rte-search-input" type="text" placeholder="🔍 Search across all open dump tabs… (double-click result to jump)"
    oninput="rteDumpSearch(this.value)"
    style="width:100%;height:28px;padding:0 8px;border:1px solid #EDEBE9;border-radius:2px;font-family:inherit;font-size:12px;outline:none;"
    onfocus="this.style.borderColor='#0078D4'" onblur="this.style.borderColor='#EDEBE9'">
  <div id="rte-search-results" style="position:absolute;left:0;right:0;z-index:50;"></div>
  </div>
  <div class="card">
  <div class="card-title">💥 Runtime Dumps
    <span style="font-weight:400;font-size:11px;color:#605E5C;margin-left:6px;">${count} dump${count!==1?'s':''} found</span>
  </div>
  <div style="padding:6px 12px 8px 12px;font-size:11px;color:#605E5C;border-bottom:1px solid #EDEBE9;background:#F8F8F7;">
    Scanned: ${pathList}
  </div>
  <div style="overflow-x:auto;max-height:calc(100vh - 200px);overflow-y:auto;">
  <table class="data-table" style="white-space:nowrap;width:auto;min-width:100%;">
  <thead style="position:sticky;top:0;z-index:5;"><tr>
    <th>Date/Time</th>
    <th>Service</th>
    <th>Virtual Host</th>
    <th>Port</th>
    <th>Reason</th>
    <th>Tenant</th>
    <th>File</th>
  </tr></thead><tbody>`

  // group by virtualHost — insert a separator row when host changes
  let lastHost=null
  for(const d of dumps){
    let dtDisplay=d.datetime
    const dtm=d.datetime.match(/^(\d{4})(\d{2})(\d{2})-(\d{2})(\d{2})(\d{2})$/)
    if(dtm)dtDisplay=`${dtm[1]}-${dtm[2]}-${dtm[3]} ${dtm[4]}:${dtm[5]}:${dtm[6]}`
    const tenantCell=d.tenant?tag('tag-purple',d.tenant):'<span style="color:#A19F9D;">SYSTEMDB</span>'
    const approxPathLen=(loadedFolderName?loadedFolderName.length+1:0)+(d.scannedPath?d.scannedPath.length+1:0)+d.filename.length
    const pathWarn=approxPathLen>210?`<span title="Estimated path length ~${approxPathLen} chars — may exceed Windows 255 char limit. Use 'Load runtime dump only' to open directly." style="cursor:help;margin-left:4px;">⚠️</span>`  :''

    if(d.virtualHost!==lastHost){
      lastHost=d.virtualHost
      html+=`<tr><td colspan="7" style="background:#F3F2F1;color:#605E5C;font-size:11px;font-weight:600;padding:5px 12px;border-top:2px solid #EDEBE9;border-bottom:1px solid #EDEBE9;">
        🖥️ ${escHtml(d.virtualHost)}
      </td></tr>`
    }

    html+=`<tr style="cursor:pointer;" onclick="rteDumpOpenTab(${d._idx})" oncontextmenu="event.preventDefault();showRteCtxMenu(${d._idx},event.clientX,event.clientY)" title="Click to open dump in new tab">
      <td><span class="mono">${escHtml(dtDisplay)}</span></td>
      <td>${tag('tag-cyan',d.serviceName)}</td>
      <td><span class="mono">${escHtml(d.virtualHost)}</span></td>
      <td><code>${escHtml(d.port)}</code></td>
      <td>${tag('tag-red',d.reason)}</td>
      <td>${tenantCell}</td>
      <td><span class="mono" style="font-size:10px;color:#605E5C;">${escHtml(d.filename)}</span>${pathWarn}</td>
    </tr>`
  }
  html+=`</tbody></table></div></div>`
  return html
}

async function rteDumpOpenTab(idx){
  const d=rteDumpHandles[parseInt(idx)]
  if(!d)return

  const tabId='rte-dump-'+idx
  const tabBar=document.getElementById('rte-tabbar')
  const tabContent=document.getElementById('rte-tabcontent')
  if(!tabBar||!tabContent)return

  // if tab already exists just switch to it
  if(tabBar.querySelector(`[data-rteid="${tabId}"]`)){
    rteTabSwitch(tabId)
    return
  }

  // format label
  let dtDisplay=d.datetime
  const dtm=d.datetime.match(/^(\d{4})(\d{2})(\d{2})-(\d{2})(\d{2})(\d{2})$/)
  if(dtm)dtDisplay=`${dtm[2]}-${dtm[3]} ${dtm[4]}:${dtm[5]}`
  const label=`${d.serviceName} · ${d.reason.length>20?d.reason.substring(0,20)+'…':d.reason} · ${dtDisplay}`

  // build tab button with close
  const btn=document.createElement('button')
  btn.dataset.rteid=tabId
  btn.style.cssText='display:inline-flex;align-items:center;gap:6px;height:36px;padding:0 10px 0 14px;border:none;border-bottom:2px solid transparent;background:transparent;font-family:inherit;font-size:11px;color:#605E5C;cursor:pointer;white-space:nowrap;max-width:280px;'
  const labelSpan=document.createElement('span')
  labelSpan.title=d.filename
  labelSpan.style.cssText='overflow:hidden;text-overflow:ellipsis;'
  labelSpan.textContent=label
  const closeBtn=document.createElement('span')
  closeBtn.textContent='×'
  closeBtn.style.cssText='font-size:14px;line-height:1;opacity:0.5;padding:0 2px;'
  closeBtn.onclick=(e)=>{
    e.stopPropagation()
    btn.remove()
    const pnl=tabContent.querySelector(`[data-rtepanel="${tabId}"]`)
    if(pnl)pnl.remove()
    // switch back to overview
    const firstBtn=tabBar.querySelector('button[data-rteid="overview"]')
    if(firstBtn)firstBtn.click()
  }
  btn.appendChild(labelSpan)
  btn.appendChild(closeBtn)
  btn.onclick=()=>rteTabSwitch(tabId)
  tabBar.appendChild(btn)

  // build panel
  const panel=document.createElement('div')
  panel.dataset.rtepanel=tabId
  panel.style.cssText='display:none;overflow-y:auto;height:100%;'
  panel.innerHTML='<div style="padding:16px;color:#A19F9D;font-size:12px;">Loading…</div>'
  tabContent.appendChild(panel)

  rteTabSwitch(tabId)

  try{
    const file=await d.handle.getFile()
    const text=await file.text()
    panel.innerHTML=renderRteDumpFileContent(text,d.filename)
  }catch(e){
    const relPath=(loadedFolderName?loadedFolderName+'/':'')+
                  (d.scannedPath?d.scannedPath+'/':'')+d.filename
    const pathLen=relPath.length
    const isPathTooLong=e.name==='NotFoundError'&&pathLen>210
    const isPermission=e.name==='NotFoundError'||e.name==='NotAllowedError'||e.name==='SecurityError'
    let msg
    if(isPathTooLong){
      msg=`<strong>Path too long (~${pathLen} relative chars)</strong> — Windows has a limit of 255 characters. The full path to this file likely exceeds that limit.<br><br>
        <code style="font-size:10px;word-break:break-all;">${escHtml(relPath)}</code><br><br>
        <button class="btn-sm" onclick="rteDumpOpenViaPickerInTab(${d._idx})">📂 Pick file manually (opens with correct name)</button>
        &nbsp; or enable long path support in Windows: <code>HKLM\\SYSTEM\\CurrentControlSet\\Control\\FileSystem\\LongPathsEnabled = 1</code>`
    } else if(isPermission){
      msg=`Could not read <strong>${escHtml(d.filename)}</strong> — the browser lost access to the directory. Please reload the FSID folder using <strong>Load FSID</strong>.`
    } else {
      msg=`Error: ${escHtml(String(e))}`
    }
    panel.innerHTML=`<div style="padding:16px;"><div class="not-found-msg" style="flex-direction:column;align-items:flex-start;gap:8px;"><span class="nf-icon">⚠️</span><span style="line-height:1.6;">${msg}</span></div></div>`
  }
}

async function rteDumpOpenViaPickerInTab(idx){
  // user picks the file manually (workaround for long path) — use real filename from scan as label
  const d=rteDumpHandles[parseInt(idx)]
  if(!d)return
  let fileHandle
  try{
    ;[fileHandle]=await window.showOpenFilePicker({
      id:'rte-longpath',
      types:[{description:'Runtime Dump',accept:{'text/plain':['.trc','.txt']}}],
      multiple:false,
      ...(_lastPickedHandle?{startIn:_lastPickedHandle}:{})
    })
  }catch(e){if(e.name!=='AbortError')alert('Error: '+e.message);return}
  _lastPickedHandle=fileHandle
  const file=await fileHandle.getFile()
  const text=await file.text()
  // use the real scanned filename as label, not the 8.3 short name
  const realName=d.filename
  const tabId='rte-dump-'+idx
  const tabBar=document.getElementById('rte-tabbar')
  const tabContent=document.getElementById('rte-tabcontent')
  if(!tabBar||!tabContent)return
  // replace the error panel content with the real dump
  const existingPanel=tabContent.querySelector(`[data-rtepanel="${tabId}"]`)
  if(existingPanel){
    existingPanel.innerHTML=renderRteDumpFileContent(text,realName)
    rteTabSwitch(tabId)
    return
  }
  // tab button
  let dtDisplay=d.datetime
  const dtm=d.datetime.match(/^(\d{4})(\d{2})(\d{2})-(\d{2})(\d{2})(\d{2})$/)
  if(dtm)dtDisplay=`${dtm[2]}-${dtm[3]} ${dtm[4]}:${dtm[5]}`
  const label=`${d.serviceName} · ${d.reason.length>20?d.reason.substring(0,20)+'…':d.reason} · ${dtDisplay}`
  const btn=document.createElement('button')
  btn.dataset.rteid=tabId
  btn.style.cssText='display:inline-flex;align-items:center;gap:6px;height:36px;padding:0 10px 0 14px;border:none;border-bottom:2px solid transparent;background:transparent;font-family:inherit;font-size:11px;color:#605E5C;cursor:pointer;white-space:nowrap;max-width:280px;'
  const labelSpan=document.createElement('span')
  labelSpan.title=realName
  labelSpan.style.cssText='overflow:hidden;text-overflow:ellipsis;'
  labelSpan.textContent=label
  const closeX=document.createElement('span')
  closeX.textContent='×'
  closeX.style.cssText='font-size:14px;line-height:1;opacity:0.5;padding:0 2px;'
  closeX.onclick=(e)=>{e.stopPropagation();btn.remove();const p=tabContent.querySelector(`[data-rtepanel="${tabId}"]`);if(p)p.remove();tabBar.querySelector('[data-rteid="overview"]')?.click()}
  btn.appendChild(labelSpan);btn.appendChild(closeX)
  btn.onclick=()=>rteTabSwitch(tabId)
  tabBar.appendChild(btn)
  const pnl=document.createElement('div')
  pnl.dataset.rtepanel=tabId
  pnl.style.cssText='display:none;overflow-y:auto;'
  pnl.innerHTML=renderRteDumpFileContent(text,realName)
  tabContent.appendChild(pnl)
  rteTabSwitch(tabId)
}

async function rteDumpLoadSingle(){
  let fileHandle
  try{
    ;[fileHandle]=await window.showOpenFilePicker({
      id:'rte-single',
      types:[{description:'Runtime Dump',accept:{'text/plain':['.trc','.txt']}}],
      multiple:false,
      ...(_lastPickedHandle?{startIn:_lastPickedHandle}:{})
    })
  }catch(e){if(e.name!=='AbortError')alert('Error: '+e.message);return}
  _lastPickedHandle=fileHandle
  const fname=fileHandle.name
  // Parse filename — fall back to a minimal stub for non-standard names
  const parsed=parseRteDumpFilename(fname)||{
    filename:fname,serviceName:fname.replace(/\..*/,''),virtualHost:'',port:'',
    datetime:'',seq:'0',reason:fname
  }
  const sid=newSessionId()
  const color=FSID_COLORS[fsidSessions.length%FSID_COLORS.length]
  const s={
    id:sid,label:'💥 '+fname,type:'rtedump-single',color,
    captureInfo:'',loadedFiles:{},loadedFolderName:'',
    versionHistoryHandle:null,configFileHandles:[],configRefHandles:{},configRefData:{},
    telemetryHandle:null,nsHistoryHandles:[],
    rteDumpHandles:[{...parsed,handle:fileHandle,scannedPath:fileHandle._path||fname,tenant:'',_idx:0}],
    rteDumpScannedPaths:[],rteDumpHdbFound:true,crashDumpHandles:[],
    topoData:null,hsiLcmLogsData:null,hsiZipFsids:[]
  }
  fsidSessions.push(s)
  activeFsidId=sid
  renderNavTree()
  activateNavItem(sid,'rtedumps')
  await new Promise(r=>setTimeout(r,0))
  rteDumpOpenTab(0)
}

// ── Runtime Dump Search ───────────────────────────────────────────────────
// called from the search input in renderRteDumps
function rteDumpSearch(query){
  const q=query.trim().toLowerCase()
  const resultsDiv=document.getElementById('rte-search-results')
  if(!resultsDiv)return
  if(!q){resultsDiv.innerHTML='';return}

  // search in all loaded dump text — we search over filename, reason, serviceName, virtualHost
  // for deeper search we also search the already-rendered tab panels
  const hits=[]

  // quick metadata search over all handles
  for(const d of rteDumpHandles){
    const haystack=(d.filename+' '+d.serviceName+' '+d.reason+' '+d.virtualHost+' '+d.datetime).toLowerCase()
    if(haystack.includes(q)){
      hits.push({type:'meta',d,match:null})
    }
  }

  // search inside open tab panels
  for(const panel of document.querySelectorAll('#rte-tabcontent [data-rtepanel]')){
    const pid=panel.dataset.rtepanel
    if(pid==='overview')continue
    // walk all text nodes
    const walker=document.createTreeWalker(panel,NodeFilter.SHOW_TEXT)
    let node,lineHits=[]
    while((node=walker.nextNode())){
      const txt=node.textContent
      if(txt.toLowerCase().includes(q)&&txt.trim().length>2){
        // find nearest named ancestor (collapse-header span or th/td)
        let el=node.parentElement
        while(el&&el!==panel&&!el.matches('.collapse-header,.collapse-panel')){el=el.parentElement}
        const sectionHeader=el&&el.matches('.collapse-panel')
          ?el.querySelector(':scope > .collapse-header')
          :null
        const sectionLabel=sectionHeader?sectionHeader.textContent.trim().substring(0,60):''
        const context=txt.trim().substring(0,100)
        lineHits.push({panelId:pid,sectionEl:el,sectionLabel,context})
      }
    }
    // deduplicate by sectionEl
    const seen=new Set()
    for(const h of lineHits){
      const key=h.sectionLabel+h.context.substring(0,30)
      if(!seen.has(key)){seen.add(key);hits.push({type:'content',...h})}
    }
  }

  if(!hits.length){resultsDiv.innerHTML='<div style="padding:6px 8px;color:#A19F9D;font-size:11px;">No results</div>';return}

  let html='<div style="max-height:320px;overflow-y:auto;border:1px solid #EDEBE9;border-radius:2px;background:#fff;">'
  for(let i=0;i<Math.min(hits.length,100);i++){
    const h=hits[i]
    if(h.type==='meta'){
      let dt=h.d.datetime
      const m=dt.match(/^(\d{4})(\d{2})(\d{2})-(\d{2})(\d{2})(\d{2})$/)
      if(m)dt=`${m[1]}-${m[2]}-${m[3]} ${m[4]}:${m[5]}:${m[6]}`
      html+=`<div style="padding:5px 10px;border-bottom:1px solid #F3F2F1;cursor:pointer;font-size:11px;"
        title="Double-click to open dump"
        ondblclick="rteDumpOpenTab(${h.d._idx})">
        <span style="color:#0078D4;font-weight:600;">${escHtml(h.d.serviceName)}</span>
        <span style="color:#605E5C;margin:0 6px;">·</span>
        <span style="color:#CF1322;">${escHtml(h.d.reason)}</span>
        <span style="color:#605E5C;margin:0 6px;">·</span>
        <span class="mono" style="color:#605E5C;">${escHtml(dt)}</span>
        <span style="font-size:10px;color:#A19F9D;margin-left:6px;">(metadata)</span>
      </div>`
    } else {
      // highlight match in context
      const ctx=h.context
      const lo=ctx.toLowerCase()
      const idx2=lo.indexOf(q)
      let display=escHtml(ctx)
      if(idx2>=0){
        const pre=escHtml(ctx.substring(0,idx2))
        const match=escHtml(ctx.substring(idx2,idx2+q.length))
        const post=escHtml(ctx.substring(idx2+q.length))
        display=`${pre}<mark style="background:#FFF176;padding:0;">${match}</mark>${post}`
      }
      html+=`<div style="padding:5px 10px;border-bottom:1px solid #F3F2F1;cursor:pointer;font-size:11px;"
        title="Double-click to jump to section"
        ondblclick="rteDumpJumpTo('${escHtml(h.panelId)}','${escHtml(h.sectionLabel.replace(/'/g,"\\'"))}')">
        <div style="color:#605E5C;font-size:10px;margin-bottom:2px;font-family:Consolas,monospace;">${escHtml(h.sectionLabel||h.panelId)}</div>
        <span class="mono" style="color:#323130;">${display}</span>
      </div>`
    }
  }
  if(hits.length>100)html+=`<div style="padding:4px 10px;font-size:10px;color:#A19F9D;">${hits.length-100} more results…</div>`
  html+='</div>'
  resultsDiv.innerHTML=html
}

function rteDumpTabSearch(uid,query,resId){
  const q=query.trim().toLowerCase()
  const resultsDiv=document.getElementById(resId)
  if(!resultsDiv)return
  if(!q){resultsDiv.innerHTML='';return}

  // find the panel that contains this search bar (parent with data-rtepanel)
  const searchInput=document.getElementById(`rte-ts-${uid}`)
  if(!searchInput)return
  let panel=searchInput.parentElement
  while(panel&&!panel.dataset.rtepanel)panel=panel.parentElement
  if(!panel)return

  const hits=[]
  const seen=new Set()
  const walker=document.createTreeWalker(panel,NodeFilter.SHOW_TEXT)
  let node
  while((node=walker.nextNode())){
    const txt=node.textContent
    if(!txt.toLowerCase().includes(q)||txt.trim().length<3)continue
    // find nearest collapse-panel ancestor
    let el=node.parentElement
    while(el&&el!==panel&&!el.classList.contains('collapse-panel'))el=el.parentElement
    if(!el||el===panel)continue
    const hdr=el.querySelector(':scope > .collapse-header')
    const sectionLabel=hdr?hdr.textContent.trim().substring(0,80):''
    const context=txt.trim().substring(0,120)
    const key=sectionLabel+context.substring(0,40)
    if(!seen.has(key)){
      seen.add(key)
      hits.push({el,sectionLabel,context})
    }
  }

  if(!hits.length){resultsDiv.innerHTML='<div style="border:1px solid #EDEBE9;border-radius:2px;background:#fff;padding:6px 8px;font-size:11px;color:#A19F9D;">No results</div>';return}

  let html='<div style="max-height:280px;overflow-y:auto;border:1px solid #EDEBE9;border-radius:2px;background:#fff;">'
  const show=Math.min(hits.length,80)
  for(let i=0;i<show;i++){
    const h=hits[i]
    const ctx=h.context
    const lo=ctx.toLowerCase()
    const idx2=lo.indexOf(q)
    let display=escHtml(ctx)
    if(idx2>=0){
      display=escHtml(ctx.substring(0,idx2))
        +`<mark style="background:#FFF176;padding:0;">${escHtml(ctx.substring(idx2,idx2+q.length))}</mark>`
        +escHtml(ctx.substring(idx2+q.length))
    }
    // store section label on element for jump
    const elId=h.el.id||(`rte-hit-${uid}-${i}`)
    if(!h.el.id)h.el.id=elId
    html+=`<div style="padding:5px 10px;border-bottom:1px solid #F3F2F1;cursor:pointer;font-size:11px;"
      title="Double-click to jump"
      ondblclick="rteDumpTabJump('${elId}','${escHtml(q.replace(/'/g,"\\'"))}')">
      <div style="font-family:Consolas,monospace;font-size:10px;color:#605E5C;margin-bottom:2px;">${escHtml(h.sectionLabel)}</div>
      <span class="mono" style="color:#323130;">${display}</span>
    </div>`
  }
  if(hits.length>show)html+=`<div style="padding:4px 10px;font-size:10px;color:#A19F9D;">${hits.length-show} more…</div>`
  html+='</div>'
  resultsDiv.innerHTML=html
}

function rteDumpTabJump(elId,query){
  const el=document.getElementById(elId)
  if(!el)return
  // open all ancestor collapse-panels up to the tab panel root
  let ancestor=el
  while(ancestor){
    if(ancestor.classList&&ancestor.classList.contains('collapse-panel'))
      ancestor.classList.add('open')
    if(ancestor.dataset&&ancestor.dataset.rtepanel)break
    ancestor=ancestor.parentElement
  }
  el.classList.add('open')
  setTimeout(()=>{
    el.scrollIntoView({block:'start',behavior:'smooth'})
    el.style.outline='2px solid #0078D4'
    setTimeout(()=>el.style.outline='',20000)
    // highlight matching text inside the element
    if(query){
      const addedMarks=[]
      const q=query.toLowerCase()
      const walker=document.createTreeWalker(el,NodeFilter.SHOW_TEXT)
      const nodes=[]
      let n
      while((n=walker.nextNode())){
        if(n.textContent.toLowerCase().includes(q))nodes.push(n)
      }
      for(const textNode of nodes){
        const txt=textNode.textContent
        const lo=txt.toLowerCase()
        const idx=lo.indexOf(q)
        if(idx<0)continue
        const parent=textNode.parentNode
        if(!parent)continue
        const before=document.createTextNode(txt.substring(0,idx))
        const mark=document.createElement('mark')
        mark.style.cssText='background:#FFF176;padding:0;border-radius:2px;'
        mark.textContent=txt.substring(idx,idx+q.length)
        const after=document.createTextNode(txt.substring(idx+q.length))
        parent.insertBefore(before,textNode)
        parent.insertBefore(mark,textNode)
        parent.insertBefore(after,textNode)
        parent.removeChild(textNode)
        addedMarks.push(mark)
      }
      // remove highlights after 4s
      setTimeout(()=>{
        for(const m of addedMarks){
          const p=m.parentNode
          if(p){p.replaceChild(document.createTextNode(m.textContent),m);p.normalize()}
        }
      },20000)
    }
  },30)
}

function rteTabSwitch(id){
  const tabBar=document.getElementById('rte-tabbar')
  const tabContent=document.getElementById('rte-tabcontent')
  if(!tabBar||!tabContent)return
  tabBar.querySelectorAll('button[data-rteid]').forEach(b=>{
    const a=b.dataset.rteid===id
    b.style.color=a?'#0078D4':'#605E5C'
    b.style.borderBottom=a?'2px solid #0078D4':'2px solid transparent'
    b.style.fontWeight=a?'600':'normal'
    b.style.background=a?'#EFF6FC':'transparent'
  })
  tabContent.querySelectorAll('[data-rtepanel]').forEach(p=>p.style.display='none')
  const active=tabContent.querySelector(`[data-rtepanel="${id}"]`)
  if(active)active.style.display='block'
}

function rteDumpJumpTo(panelId,sectionLabel){
  const tabBar=document.getElementById('rte-tabbar')
  const tabContent=document.getElementById('rte-tabcontent')
  if(!tabBar||!tabContent)return
  // switch to the tab
  const tabBtn=tabBar.querySelector(`[data-rteid="${panelId}"]`)
  if(tabBtn)tabBtn.click()
  // find the collapse-panel whose header contains the sectionLabel
  const panel=tabContent.querySelector(`[data-rtepanel="${panelId}"]`)
  if(!panel)return
  // search for matching header
  for(const cp of panel.querySelectorAll('.collapse-panel')){
    const hdr=cp.querySelector(':scope > .collapse-header')
    if(hdr&&hdr.textContent.trim().includes(sectionLabel.substring(0,40))){
      // open it if not already
      if(!cp.classList.contains('open'))cp.classList.add('open')
      setTimeout(()=>cp.scrollIntoView({block:'start',behavior:'smooth'}),50)
      // flash highlight
      cp.style.outline='2px solid #0078D4'
      setTimeout(()=>cp.style.outline='',1500)
      return
    }
  }
}

function parseRteSemiCsvLine(line){
  // parse ;"value";"val2";123; — handles quoted and unquoted
  const result=[]
  let i=0
  while(i<line.length){
    if(line[i]==='"'){
      i++
      let val='',escaped=false
      while(i<line.length){
        if(escaped){val+=line[i];escaped=false}
        else if(line[i]==='\\'){escaped=true}
        else if(line[i]==='"'){i++;break}
        else val+=line[i]
        i++
      }
      result.push(val)
      if(line[i]===';')i++
    } else {
      const end=line.indexOf(';',i)
      if(end===-1){result.push(line.substring(i));break}
      result.push(line.substring(i,end))
      i=end+1
    }
  }
  return result
}

function renderRteDumpFileContent(text,filename){
  // unique prefix per render call to avoid ID collisions across tabs
  const uid='r'+Math.random().toString(36).slice(2,8)
  const rawLines=text.split('\n').map(l=>l.replace(/\r$/,''))

  // Real top-level section header: starts at col 0 with [UPPERCASE_NAME]
  // but NOT [OK] (which is a section footer)
  function isSectionStart(line){
    return /^\[([A-Z][A-Z_0-9]*)\]/.test(line)&&!/^\[OK[\] ]/.test(line)
  }

  // Split into preLines (before first section) + sections[]
  const sections=[]
  let curSec=null
  const preLines=[]
  for(const line of rawLines){
    if(isSectionStart(line)){
      if(curSec)sections.push(curSec)
      const m=line.match(/^\[([A-Z][A-Z_0-9]*)\]/)
      curSec={name:m[1],headerLine:line,lines:[]}
    } else if(!curSec){
      preLines.push(line)
    } else {
      curSec.lines.push(line)
    }
  }
  if(curSec)sections.push(curSec)

  let html=''

  // ── 1) RAW HEADER BLOCK: preLines + [BUILD] section ────────────────────
  const buildSec=sections.find(s=>s.name==='BUILD')
  const rawHeaderLines=[...preLines]
  if(buildSec){rawHeaderLines.push(buildSec.headerLine,...buildSec.lines)}
  if(rawHeaderLines.some(l=>l.trim())){
    html+=`<div style="background:#F8F8F7;border-bottom:1px solid #EDEBE9;padding:10px 14px;">
    <pre style="font-family:'Consolas','Courier New',monospace;font-size:11px;color:#323130;margin:0;white-space:pre-wrap;word-break:break-all;">${escHtml(rawHeaderLines.join('\n'))}</pre>
    </div>`
  }

  // ── 2) COLLAPSIBLE SECTIONS ──────────────────────────────────────────────
  const tocItems=[]
  const blockDivs=[]
  let blockIdx=0
  const mkid=()=>`${uid}-${blockIdx++}`

  for(const sec of sections){
    if(sec.name==='BUILD')continue  // already rendered in raw header

    const bid=mkid()

    if(sec.name==='STATISTICS'){
      // ── STATISTICS: parse M_xxx table sub-blocks ──
      // split section content into sub-blocks by empty line
      const subBlocks=[]
      let cur=[]
      for(const l of sec.lines){
        if(l.trim()===''){if(cur.length)subBlocks.push(cur);cur=[]}
        else cur.push(l)
      }
      if(cur.length)subBlocks.push(cur)

      const statsToc=[]
      const statsDivs=[]

      for(const block of subBlocks){
        if(!block.length)continue
        const firstLine=block[0].trim()
        // skip [OK]/-- footer blocks
        if(/^\[OK\]/.test(firstLine)||firstLine==='--')continue

        const footerIdx=block.findIndex((l,i)=>i>0&&l.trim().startsWith('('))
        const tableHeader=firstLine
        const colLine=block.length>1?block[1].trim():''
        const dataEnd=footerIdx>=0?footerIdx:block.length
        const dataLines=block.slice(2,dataEnd)
        const footerLine=footerIdx>=0?block[footerIdx].trim():''
        const tableName=tableHeader.split('[')[0].trim()
        const fmatch=footerLine.match(/,\s*(\d+)\s*rows?\s+in\s+([\d.]+us)/)
        const isTableBlock=colLine.startsWith('"')||colLine.startsWith("'")
        const sbid=mkid()

        if(!isTableBlock){
          const rawContent=block.slice(1,dataEnd).join('\n')
          statsToc.push({id:sbid,name:tableName,rows:-1})
          statsDivs.push(`<div class="collapse-panel" id="${sbid}">
            <div class="collapse-header" onclick="toggleCollapse('${sbid}')" style="font-family:'Consolas','Courier New',monospace;font-size:11px;">
              <span style="color:#323130;">${escHtml(tableHeader)}</span>
              <span class="collapse-arrow">&#9654;</span>
            </div>
            <div class="collapse-body">
              <pre style="font-family:'Consolas','Courier New',monospace;font-size:11px;color:#323130;margin:0;padding:8px;white-space:pre-wrap;word-break:break-all;max-height:400px;overflow-y:auto;">${escHtml(rawContent)}</pre>
            </div></div>`)
          continue
        }

        // parse table
        const cols=parseRteSemiCsvLine(colLine)
        const colWidths=cols.map(c=>Math.min(80,c.replace(/\s*\[.*?\]/,'').trim().length))
        const parsedRows=[]
        for(const dl of dataLines){
          if(!dl.trim())continue
          const vals=parseRteSemiCsvLine(dl.trim())
          parsedRows.push(vals)
          for(let ci=0;ci<cols.length;ci++){const len=Math.min(80,(vals[ci]??'').length);if(len>colWidths[ci])colWidths[ci]=len}
        }
        const PX=7.5
        let tbl=`<div style="overflow-x:auto;max-height:360px;overflow-y:auto;"><table class="data-table" style="table-layout:auto;width:auto;"><thead style="position:sticky;top:0;z-index:3;"><tr>`
        for(let ci=0;ci<cols.length;ci++){
          tbl+=`<th title="${escHtml(cols[ci])}" style="min-width:${Math.round(colWidths[ci]*PX)}px;">${escHtml(cols[ci].replace(/\s*\[.*?\]/,'').trim())}</th>`
        }
        tbl+=`</tr></thead><tbody>`
        if(!parsedRows.length){
          tbl+=`<tr><td colspan="${cols.length}" style="color:#A19F9D;text-align:center;font-style:italic;">No data</td></tr>`
        } else {
          for(const vals of parsedRows){
            tbl+=`<tr>`
            for(let ci=0;ci<cols.length;ci++){
              const v=vals[ci]??''
              const isNum=v!==''&&!isNaN(Number(v))&&v.trim()!==''
              const display=v.length>80?v.substring(0,80)+'…':v
              const titleAttr=v.length>80?` title="${escHtml(v)}"`:''
              tbl+=`<td style="${isNum?'text-align:right;':''}"${titleAttr}><span class="mono">${escHtml(display)}</span></td>`
            }
            tbl+=`</tr>`
          }
        }
        tbl+=`</tbody></table></div>`
        if(footerLine)tbl+=`<div style="font-size:10px;color:#A19F9D;padding:3px 10px;">${escHtml(footerLine)}</div>`

        const rowBadge=fmatch&&parseInt(fmatch[1])>0
          ?`<span style="margin-left:8px;font-size:10px;background:#EFF6FF;color:#0078D4;border:1px solid #BAD7FF;border-radius:2px;padding:1px 6px;">${fmatch[1]} rows</span>`
          :`<span style="margin-left:8px;font-size:10px;color:#A19F9D;">0 rows</span>`
        statsToc.push({id:sbid,name:tableName,rows:fmatch?parseInt(fmatch[1]):0})
        statsDivs.push(`<div class="collapse-panel" id="${sbid}">
          <div class="collapse-header" onclick="toggleCollapse('${sbid}')" style="font-family:'Consolas','Courier New',monospace;font-size:11px;">
            <span style="color:#323130;">${escHtml(tableHeader)}${rowBadge}</span>
            <span class="collapse-arrow">&#9654;</span>
          </div>
          <div class="collapse-body" style="padding:0;">${tbl}</div></div>`)
      }

      // statistics inner content: just the sub-blocks, no TOC
      const statsInner=`<div style="padding:8px;">${statsDivs.join('')}</div>`

      tocItems.push({id:bid,name:'STATISTICS'})
      blockDivs.push(`<div class="collapse-panel" id="${bid}">
        <div class="collapse-header" onclick="toggleCollapse('${bid}')" style="font-family:'Consolas','Courier New',monospace;font-size:11px;">
          <span style="color:#323130;font-weight:600;">${escHtml(sec.headerLine)}</span>
          <span class="collapse-arrow">&#9654;</span>
        </div>
        <div class="collapse-body" style="padding:0;">${statsInner}</div></div>`)

    } else {
      // ── OTHER SECTIONS: raw collapsible ──
      const rawContent=sec.lines.join('\n')
      tocItems.push({id:bid,name:sec.name})
      blockDivs.push(`<div class="collapse-panel" id="${bid}">
        <div class="collapse-header" onclick="toggleCollapse('${bid}')" style="font-family:'Consolas','Courier New',monospace;font-size:11px;">
          <span style="color:#323130;font-weight:600;">${escHtml(sec.headerLine)}</span>
          <span class="collapse-arrow">&#9654;</span>
        </div>
        <div class="collapse-body">
          <pre style="font-family:'Consolas','Courier New',monospace;font-size:11px;color:#323130;margin:0;padding:8px 14px;white-space:pre-wrap;word-break:break-all;max-height:500px;overflow-y:auto;">${escHtml(rawContent)}</pre>
        </div></div>`)
    }
  }

  // ── search bar (per-tab, searches within this dump's rendered content) ──
  const searchBarId=`rte-ts-${uid}`
  const searchResId=`rte-tr-${uid}`
  const searchBar=`<div style="padding:8px 8px 4px 8px;position:relative;">
    <input id="${searchBarId}" type="text" placeholder="🔍 Search in this dump… (double-click result to jump)"
      oninput="rteDumpTabSearch('${uid}',this.value,'${searchResId}')"
      style="width:100%;height:26px;padding:0 8px;border:1px solid #EDEBE9;border-radius:2px;font-family:'Consolas','Courier New',monospace;font-size:11px;outline:none;"
      onfocus="this.style.borderColor='#0078D4'" onblur="this.style.borderColor='#EDEBE9'">
    <div id="${searchResId}" style="position:absolute;left:8px;right:8px;z-index:50;"></div>
  </div>`

  html=searchBar+html
  html+=`<div style="padding:8px;">${blockDivs.join('')}</div>`
  return html
}

// ============================================================
// CRASH DUMPS
// ============================================================
function renderCrashDumps(dumps,scannedPaths){
  const count=dumps.length
  const pathList=scannedPaths.length?scannedPaths.map(p=>`<code>${escHtml(p)}</code>`).join(', '):'<span style="color:#A19F9D;">none</span>'
  let html=`<div class="card">
  <div class="card-title">🛑 Crash Dumps
    <span style="font-weight:400;font-size:11px;color:#605E5C;margin-left:6px;">${count} dump${count!==1?'s':''} found</span>
  </div>
  <div style="padding:6px 12px 8px 12px;font-size:11px;color:#605E5C;border-bottom:1px solid #EDEBE9;background:#F8F8F7;">
    Scanned: ${pathList}
  </div>
  <div class="card-body" style="padding:0;">
  <table style="width:100%;border-collapse:collapse;font-size:12px;">
  <thead><tr style="background:#F3F2F1;">
    <th style="padding:6px 12px;text-align:left;font-weight:600;border-bottom:1px solid #EDEBE9;">Date/Time</th>
    <th style="padding:6px 12px;text-align:left;font-weight:600;border-bottom:1px solid #EDEBE9;">Service</th>
    <th style="padding:6px 12px;text-align:left;font-weight:600;border-bottom:1px solid #EDEBE9;">Host</th>
    <th style="padding:6px 12px;text-align:left;font-weight:600;border-bottom:1px solid #EDEBE9;">Port</th>
    <th style="padding:6px 12px;text-align:left;font-weight:600;border-bottom:1px solid #EDEBE9;">Tenant</th>
    <th style="padding:6px 12px;text-align:left;font-weight:600;border-bottom:1px solid #EDEBE9;">File</th>
  </tr></thead><tbody>`
  let lastHost=''
  for(const d of dumps){
    let dtDisplay=d.datetime
    const dtm=d.datetime.match(/^(\d{4})(\d{2})(\d{2})-(\d{2})(\d{2})(\d{2})$/)
    if(dtm)dtDisplay=`${dtm[1]}-${dtm[2]}-${dtm[3]} ${dtm[4]}:${dtm[5]}:${dtm[6]}`
    const tenantCell=d.tenant?tag('tag-purple',d.tenant):'<span style="color:#A19F9D;">SYSTEMDB</span>'
    const isIpmm=d.filename.includes('.ipmm.')
    const fileTag=isIpmm?`<span title="${escHtml(d.filename)}" style="font-size:10px;color:#605E5C;font-family:monospace;">${escHtml(d.filename)} ${tag('tag-red','binary')}</span>`:`<span class="mono" style="font-size:10px;color:#605E5C;">${escHtml(d.filename)}</span>`
    if(d.virtualHost!==lastHost){
      lastHost=d.virtualHost
      html+=`<tr><td colspan="6" style="background:#F3F2F1;color:#605E5C;font-size:11px;font-weight:600;padding:5px 12px;border-top:2px solid #EDEBE9;border-bottom:1px solid #EDEBE9;">
        🖥️ ${escHtml(d.virtualHost)}
      </td></tr>`
    }
    html+=`<tr style="cursor:pointer;${isIpmm?'opacity:0.65;':''}" onclick="${isIpmm?`alert('Binary crash dump file (.ipmm.trc) — cannot be displayed as text. Use HDBCFS to analyze this file.')`:`crashDumpOpenTab(${d._idx})`}" oncontextmenu="event.preventDefault();showCrashDumpCtxMenu(${d._idx},event.clientX,event.clientY)" title="${isIpmm?'Binary file — right-click to open in HDBCFS':'Click to view file content'}">
      <td style="padding:5px 12px;border-bottom:1px solid #F3F2F1;"><span class="mono">${escHtml(dtDisplay)}</span></td>
      <td style="padding:5px 12px;border-bottom:1px solid #F3F2F1;">${tag('tag-cyan',d.serviceName)}</td>
      <td style="padding:5px 12px;border-bottom:1px solid #F3F2F1;"><span class="mono">${escHtml(d.virtualHost)}</span></td>
      <td style="padding:5px 12px;border-bottom:1px solid #F3F2F1;"><code>${escHtml(d.port)}</code></td>
      <td style="padding:5px 12px;border-bottom:1px solid #F3F2F1;">${tenantCell}</td>
      <td style="padding:5px 12px;border-bottom:1px solid #F3F2F1;">${fileTag}</td>
    </tr>`
  }
  html+=`</tbody></table></div></div>`
  return html
}

function crashTabSwitch(id){
  const tabBar=document.getElementById('crash-tabbar')
  const tabContent=document.getElementById('crash-tabcontent')
  if(!tabBar||!tabContent)return
  tabBar.querySelectorAll('button[data-crashid]').forEach(b=>{
    const a=b.dataset.crashid===id
    b.style.color=a?'#0078D4':'#605E5C';b.style.borderBottom=a?'2px solid #0078D4':'2px solid transparent'
    b.style.fontWeight=a?'600':'normal';b.style.background=a?'#EFF6FC':'transparent'
  })
  tabContent.querySelectorAll('[data-crashpanel]').forEach(p=>p.style.display='none')
  const active=tabContent.querySelector(`[data-crashpanel="${id}"]`)
  if(active)active.style.display='block'
}

async function crashDumpOpenTab(idx){
  const d=crashDumpHandles[parseInt(idx)]
  if(!d)return
  const tabId='crash-dump-'+idx
  const tabBar=document.getElementById('crash-tabbar')
  const tabContent=document.getElementById('crash-tabcontent')
  if(!tabBar||!tabContent)return
  if(tabBar.querySelector(`[data-crashid="${tabId}"]`)){crashTabSwitch(tabId);return}
  let dtDisplay=d.datetime
  const dtm=d.datetime.match(/^(\d{4})(\d{2})(\d{2})-(\d{2})(\d{2})(\d{2})$/)
  if(dtm)dtDisplay=`${dtm[2]}-${dtm[3]} ${dtm[4]}:${dtm[5]}`
  const label=`${d.serviceName} · ${dtDisplay}`
  const btn=document.createElement('button')
  btn.dataset.crashid=tabId
  btn.style.cssText='display:inline-flex;align-items:center;gap:6px;height:36px;padding:0 10px 0 14px;border:none;border-bottom:2px solid transparent;background:transparent;font-family:inherit;font-size:11px;color:#605E5C;cursor:pointer;white-space:nowrap;max-width:280px;'
  const labelSpan=document.createElement('span');labelSpan.title=d.filename;labelSpan.style.cssText='overflow:hidden;text-overflow:ellipsis;';labelSpan.textContent=label
  const closeBtn=document.createElement('span');closeBtn.textContent='×';closeBtn.style.cssText='font-size:14px;line-height:1;opacity:0.5;padding:0 2px;'
  closeBtn.onclick=(e)=>{e.stopPropagation();btn.remove();const pnl=tabContent.querySelector(`[data-crashpanel="${tabId}"]`);if(pnl)pnl.remove();const fb=tabBar.querySelector('button[data-crashid="overview"]');if(fb)fb.click()}
  btn.appendChild(labelSpan);btn.appendChild(closeBtn);btn.onclick=()=>crashTabSwitch(tabId);tabBar.appendChild(btn)
  const panel=document.createElement('div');panel.dataset.crashpanel=tabId;panel.style.cssText='display:none;overflow-y:auto;height:100%;'
  panel.innerHTML='<div style="padding:16px;color:#A19F9D;font-size:12px;">Loading…</div>'
  tabContent.appendChild(panel);crashTabSwitch(tabId)
  try{
    const file=await d.handle.getFile()
    const text=await file.text()
    panel.innerHTML=renderRteDumpFileContent(text,d.filename)
  }catch(e){
    const relPath=(loadedFolderName?loadedFolderName+'/':'')+  (d.scannedPath?d.scannedPath+'/':'')+d.filename
    const isPermission=e.name==='NotFoundError'||e.name==='NotAllowedError'||e.name==='SecurityError'
    const msg=isPermission?`Could not read <strong>${escHtml(d.filename)}</strong> — the browser lost access to the directory.`:`Error: ${escHtml(String(e))}`
    panel.innerHTML=`<div style="padding:16px;"><div class="not-found-msg" style="flex-direction:column;align-items:flex-start;gap:8px;"><span class="nf-icon">⚠️</span><span style="line-height:1.6;">${msg}</span></div></div>`
  }
}

function showCrashDumpCtxMenu(idx,x,y){
  _crashCtxIdx=idx
  const m=document.getElementById('crash-ctx-menu')
  m.style.display='block';m.style.left=x+'px';m.style.top=y+'px'
  requestAnimationFrame(()=>{const r=m.getBoundingClientRect();if(r.right>window.innerWidth)m.style.left=(x-r.width)+'px';if(r.bottom>window.innerHeight)m.style.top=(y-r.height)+'px'})
}
function hideCrashDumpCtxMenu(){
  const m=document.getElementById('crash-ctx-menu');if(m)m.style.display='none';_crashCtxIdx=null
}
async function crashDumpOpenInHdbcfs(){
  const idx=_crashCtxIdx;hideCrashDumpCtxMenu()
  const d=crashDumpHandles[idx]
  if(!d)return
  const path=d.handle?._path
  if(!path)return
  const invoke=window.__TAURI__?.core?.invoke
  if(invoke){
    invoke('open_external_url',{url:'https://hdbcfs.me.sap.corp/app'}).catch(()=>{})
  }
  try{await navigator.clipboard.writeText(path)}catch(_){}
  const t=document.createElement('div')
  t.textContent='📋 File path copied — paste into HDBCFS'
  t.style.cssText='position:fixed;bottom:24px;right:24px;background:#323130;color:#fff;padding:9px 16px;border-radius:3px;font-size:12px;z-index:99999;pointer-events:none;opacity:1;transition:opacity 0.4s;'
  document.body.appendChild(t)
  setTimeout(()=>{t.style.opacity='0';setTimeout(()=>t.remove(),400)},2800)
}

// ============================================================
// STATE + APP LOGIC
// ============================================================
// ── Multi-FSID Session Management ─────────────────────────────────────────
const FSID_COLORS = ['#0078D4','#107C10','#D83B01','#8764B8','#038387','#CA5010','#0099BC','#7A7574']
let fsidSessions = []       // [{id, label, color, captureInfo, loadedFiles, loadedFolderName, versionHistoryHandle, configFileHandles, configRefHandles, configRefData, telemetryHandle, nsHistoryHandles, rteDumpHandles, rteDumpScannedPaths, topoData}]
const HANA_INI_FILES=['global.ini','indexserver.ini','nameserver.ini','daemon.ini','webdispatcher.ini',
  'xsengine.ini','esserver.ini','dpserver.ini','statisticsserver.ini','xscontroller.ini',
  'preprocessor.ini','scriptserver.ini','compileserver.ini','rowstoremerger.ini',
  'alertserver.ini','sapcontrol.ini','executor.ini','mergedog.ini','pythonsupport.ini',
  'backint.ini','traceanalyzer.ini','hdbalert.ini','auditlog.ini','inifile_checker.ini']
let activeFsidId = null     // id of the currently viewed session
let activePanel  = null     // 'topology' | 'versionhistory' | ... for the active session
let traceExplState = null   // {sid, serverIdx, stack:[{name,handle}], entries:[...]}
let _lastPickedHandle = null  // last FileSystemHandle used in any picker — passed as startIn
let _traceCopyPath = ''       // full path of the currently open trace file, for breadcrumb copy btn

function traceCopyBreadcrumbPath(btn){
  if(!_traceCopyPath)return
  navigator.clipboard.writeText(_traceCopyPath).then(()=>{
    const prev=btn.textContent
    btn.textContent='✓'
    btn.style.color='#107C10'
    setTimeout(()=>{btn.textContent=prev;btn.style.color=''},1200)
  }).catch(()=>{})
}

// ── ctx-menu state ─────────────────────────────────────────────────────────
let ctxTargetId = null
let _rteCtxIdx = null
let _crashCtxIdx = null

// ── back-compat: these globals point into the active session ───────────────
function sess(id){ return fsidSessions.find(s=>s.id===id)||null }
function activeSess(){ return sess(activeFsidId) }

// keep old global names as getters so all existing render/parse code works unchanged
function get_loadedFiles(){ const s=activeSess(); return s?s.loadedFiles:{} }
function get_loadedFolderName(){ const s=activeSess(); return s?s.loadedFolderName:'' }
function get_rteDumpHandles(){ const s=activeSess(); return s?s.rteDumpHandles:[] }
function get_rteDumpScannedPaths(){ const s=activeSess(); return s?s.rteDumpScannedPaths:[] }
// topoData still used by canvas resize handler — proxy through active session
Object.defineProperty(window,'topoData',{get(){const s=activeSess();return s?s.topoData:null},set(v){const s=activeSess();if(s)s.topoData=v}})
// legacy: loadedFolderName referenced in rteDumpOpenTab for path-length calc
Object.defineProperty(window,'loadedFolderName',{get(){return get_loadedFolderName()},set(v){const s=activeSess();if(s)s.loadedFolderName=v}})
Object.defineProperty(window,'loadedFiles',{get(){return get_loadedFiles()},set(v){const s=activeSess();if(s)s.loadedFiles=v}})
Object.defineProperty(window,'rteDumpHandles',{get(){return get_rteDumpHandles()},set(v){const s=activeSess();if(s)s.rteDumpHandles=v}})
Object.defineProperty(window,'rteDumpScannedPaths',{get(){return get_rteDumpScannedPaths()},set(v){const s=activeSess();if(s)s.rteDumpScannedPaths=v}})
Object.defineProperty(window,'crashDumpHandles',{get(){const s=activeSess();return s?s.crashDumpHandles:[]},set(v){const s=activeSess();if(s)s.crashDumpHandles=v}})
// legacy panel-key vars used in activateNav
Object.defineProperty(window,'versionHistoryHandle',{get(){const s=activeSess();return s?s.versionHistoryHandle:null},set(v){const s=activeSess();if(s)s.versionHistoryHandle=v}})
Object.defineProperty(window,'configFileHandles',{get(){const s=activeSess();return s?s.configFileHandles:[]},set(v){const s=activeSess();if(s)s.configFileHandles=v}})
Object.defineProperty(window,'configRefHandles',{get(){const s=activeSess();return s?s.configRefHandles:{}},set(v){const s=activeSess();if(s)s.configRefHandles=v}})
Object.defineProperty(window,'configRefData',{get(){const s=activeSess();return s?s.configRefData:{}},set(v){const s=activeSess();if(s)s.configRefData=v}})
Object.defineProperty(window,'telemetryHandle',{get(){const s=activeSess();return s?s.telemetryHandle:null},set(v){const s=activeSess();if(s)s.telemetryHandle=v}})
Object.defineProperty(window,'nsHistoryHandles',{get(){const s=activeSess();return s?s.nsHistoryHandles:[]},set(v){const s=activeSess();if(s)s.nsHistoryHandles=v}})

function newSessionId(){ return 'fsid-'+(Date.now()%1e9)+'-'+Math.floor(Math.random()*9999) }
// topoData is now a property on each session (defined via Object.defineProperty above)

async function loadSmartFolder(){
  let dirHandle
  try{
    dirHandle=await window.showDirectoryPicker({mode:'read',id:'load-smart',...(_lastPickedHandle?{startIn:_lastPickedHandle}:{})})
  }catch(e){if(e.name!=='AbortError')alert('Error: '+e.message);return}
  _lastPickedHandle=dirHandle
  const n=dirHandle.name.toLowerCase()
  if(n.startsWith('hsi_nettest')){await loadHSIFolder(dirHandle);return}
  if(n.startsWith('hsi_')){await loadHSIFolder(dirHandle);return}
  if(n.startsWith('fullsysteminfodump_')){await loadFSIDFolder(dirHandle);return}
  showLoadTypeDialog(dirHandle)
}

function showLoadTypeDialog(dirHandle){
  const existing=document.getElementById('load-type-overlay')
  if(existing)existing.remove()
  const overlay=document.createElement('div')
  overlay.id='load-type-overlay'
  overlay.style.cssText='position:fixed;inset:0;background:rgba(0,0,0,0.35);z-index:9999;display:flex;align-items:center;justify-content:center;'
  const bs='display:block;width:100%;padding:9px 14px;text-align:left;background:#F3F2F1;border:1px solid #EDEBE9;border-radius:2px;font-family:inherit;font-size:13px;color:#323130;cursor:pointer;margin-bottom:6px;transition:background 0.1s;'
  const dlg=document.createElement('div')
  dlg.style.cssText='background:#fff;border-radius:4px;padding:24px 28px;max-width:400px;width:90%;box-shadow:0 8px 32px rgba(0,0,0,0.22);font-family:inherit;'
  dlg.innerHTML=
    `<div style="font-size:14px;font-weight:600;color:#323130;margin-bottom:6px;">Dump type not recognized</div>`+
    `<div style="font-size:12px;color:#605E5C;margin-bottom:18px;word-break:break-all;">"${escHtml(dirHandle.name)}"<br><br>Please select the type:</div>`+
    `<button data-action="hsi"     style="${bs}">🗂️ &nbsp;<strong>HSI</strong></button>`+
    `<button data-action="hsi"     style="${bs}">🌐 &nbsp;<strong>HSI_NETTEST</strong></button>`+
    `<button data-action="fsid"    style="${bs}">📦 &nbsp;<strong>FSID</strong> – Tenant</button>`+
    `<button data-action="fsid"    style="${bs}">📦 &nbsp;<strong>FSID</strong> – SYSTEMDB</button>`+
    `<div style="text-align:right;margin-top:10px;"><button data-action="cancel" style="padding:6px 16px;background:#fff;border:1px solid #C8C6C4;border-radius:2px;font-family:inherit;font-size:12px;cursor:pointer;">Cancel</button></div>`
  overlay.appendChild(dlg)
  document.body.appendChild(overlay)
  const close=()=>overlay.remove()
  overlay.addEventListener('click',e=>{if(e.target===overlay)close()})
  dlg.querySelectorAll('button[data-action]').forEach(btn=>{
    btn.addEventListener('mouseenter',()=>{if(btn.dataset.action!=='cancel')btn.style.background='#EDEBE9'})
    btn.addEventListener('mouseleave',()=>{if(btn.dataset.action!=='cancel')btn.style.background='#F3F2F1'})
    btn.addEventListener('click',async()=>{
      close()
      if(btn.dataset.action==='hsi')await loadHSIFolder(dirHandle)
      else if(btn.dataset.action==='fsid')await loadFSIDFolder(dirHandle)
    })
  })
}

async function loadFSIDFolder(existingHandle){
  try{
    const dirHandle=existingHandle||await window.showDirectoryPicker({mode:'read',id:'load-fsid',...(_lastPickedHandle?{startIn:_lastPickedHandle}:{})})
    _lastPickedHandle=dirHandle
    const sid=newSessionId()
    const color=FSID_COLORS[fsidSessions.length%FSID_COLORS.length]
    const s={
      id:sid, label:dirHandle.name, color, captureInfo:'',
      loadedFiles:{}, loadedFolderName:dirHandle.name,
      versionHistoryHandle:null, configDirHandle:null, _configScanned:false, configFileHandles:[], configRefHandles:{}, configRefData:{},
      telemetryHandle:null, nsHistoryHandles:[], availabilityHandles:[], rteDumpHandles:[], rteDumpScannedPaths:[], rteDumpHdbFound:false, crashDumpHandles:[],
      hostsFileHandle:null,
      topoData:null, traceExplorerData:null
    }
    activeFsidId=sid
    // switch proxy to new session before any reads
    for await(const[name,handle]of dirHandle.entries()){if(handle.kind==='file')s.loadedFiles[name.toLowerCase()]=handle}
    try{
      const sys=await dirHandle.getDirectoryHandle('SYS')
      const global=await sys.getDirectoryHandle('global')
      const hdb=await global.getDirectoryHandle('hdb')
      try{s.versionHistoryHandle=await hdb.getFileHandle('versionhistory.csv')}catch(e){s.versionHistoryHandle=null}
      try{
        const custom=await hdb.getDirectoryHandle('custom')
        s.configDirHandle=await custom.getDirectoryHandle('config')
      }catch(e){}
      try{
        const exe=await sys.getDirectoryHandle('exe')
        const hdbExe=await exe.getDirectoryHandle('hdb')
        const refConfig=await hdbExe.getDirectoryHandle('config')
        const _rf=new Set()
        try{for await(const[name,handle]of refConfig.entries()){if(handle.kind==='file'&&name.endsWith('.ini')){s.configRefHandles[name]=handle;_rf.add(name)}}}catch(e){}
        for(const fn of HANA_INI_FILES){if(!_rf.has(fn)){try{s.configRefHandles[fn]=await refConfig.getFileHandle(fn)}catch(e){}}}
      }catch(e){}
    }catch(e){}
    try{const etcDir=await dirHandle.getDirectoryHandle('etc');s.hostsFileHandle=await etcDir.getFileHandle('hosts')}catch(e){}
    s.telemetryHandle=s.loadedFiles['telemetrydata.csv']||null
    try{
      for await(const[n1,h1]of dirHandle.entries()){
        if(h1.kind!=='directory'||!/^HDB\d\d$/.test(n1))continue
        for await(const[n2,h2]of h1.entries()){
          if(h2.kind!=='directory')continue
          try{
            const trace=await h2.getDirectoryHandle('trace')
            try{const fh=await trace.getFileHandle('nameserver_history.trc');s.nsHistoryHandles.push({hostName:n2,handle:fh})}catch(e){}
            for await(const[fn,fh2]of trace.entries()){if(fh2.kind==='file'&&fn.startsWith('system_availability_')&&fn.endsWith('.trc')){s.availabilityHandles.push({hostName:n2,handle:fh2});break}}
          }catch(e){}
        }
      }
      s.nsHistoryHandles.sort((a,b)=>a.hostName.localeCompare(b.hostName))
      s.availabilityHandles.sort((a,b)=>a.hostName.localeCompare(b.hostName))
    }catch(e){s.nsHistoryHandles=[];s.availabilityHandles=[]}
    try{
      for await(const[n1,h1]of dirHandle.entries()){
        if(h1.kind!=='directory'||!/^HDB\d\d$/.test(n1))continue
        s.rteDumpHdbFound=true
        for await(const[n2,h2]of h1.entries()){
          if(h2.kind!=='directory')continue
          try{
            const trace=await h2.getDirectoryHandle('trace')
            const tracePath=`${n1}/${n2}/trace`
            let foundHere=false
            for await(const[fname,fh]of trace.entries()){
              if(fh.kind==='file'&&fname.includes('.rtedump.')){
                const parsed=parseRteDumpFilename(fname)
                if(parsed){s.rteDumpHandles.push({...parsed,handle:fh,scannedPath:tracePath});foundHere=true}
              } else if(fh.kind==='file'&&fname.includes('.crashdump.')){
                const parsed=parseCrashDumpFilename(fname)
                if(parsed)s.crashDumpHandles.push({...parsed,handle:fh,scannedPath:tracePath})
              } else if(fh.kind==='directory'&&fname.startsWith('DB_')){
                const tenantTracePath=`${tracePath}/${fname}`
                let foundTenant=false
                try{
                  for await(const[tf,th]of fh.entries()){
                    if(th.kind==='file'&&tf.includes('.rtedump.')){
                      const parsed=parseRteDumpFilename(tf)
                      if(parsed){s.rteDumpHandles.push({...parsed,handle:th,tenant:fname.replace(/^DB_/,''),scannedPath:tenantTracePath});foundTenant=true}
                    } else if(th.kind==='file'&&tf.includes('.crashdump.')){
                      const parsed=parseCrashDumpFilename(tf)
                      if(parsed)s.crashDumpHandles.push({...parsed,handle:th,tenant:fname.replace(/^DB_/,''),scannedPath:tenantTracePath})
                    }
                  }
                }catch(e){}
                if(foundTenant)s.rteDumpScannedPaths.push(tenantTracePath)
              }
            }
            if(foundHere)s.rteDumpScannedPaths.push(tracePath)
          }catch(e){}
        }
      }
      s.rteDumpScannedPaths=[...new Set(s.rteDumpScannedPaths)]
      s.rteDumpHandles.sort((a,b)=>{
        const host=a.virtualHost.localeCompare(b.virtualHost)
        if(host!==0)return host
        const svc=a.serviceName.localeCompare(b.serviceName)
        if(svc!==0)return svc
        return b.datetime.localeCompare(a.datetime)
      })
      s.rteDumpHandles.forEach((d,i)=>d._idx=i)
      s.crashDumpHandles.sort((a,b)=>{const h=a.virtualHost.localeCompare(b.virtualHost);if(h!==0)return h;const sv=a.serviceName.localeCompare(b.serviceName);if(sv!==0)return sv;return b.datetime.localeCompare(a.datetime)})
      s.crashDumpHandles.forEach((d,i)=>d._idx=i)
    }catch(e){s.rteDumpHandles=[]}
    // parse capture info from log.txt
    try{
      const logHandle=s.loadedFiles['log.txt']
      if(logHandle){
        const logFile=await logHandle.getFile()
        const logText=await logFile.text()
        const lines=logText.split('\n')
        const writingLine=lines.find(l=>l.trim().startsWith('Writing to file'))
        if(writingLine){
          const m=writingLine.match(/fullsysteminfodump_[^_]+_[^_]+_(.+?)_(\d{4})_(\d{2})_(\d{2})_(\d{2})_(\d{2})_(\d{2})\.(zip|tar)/)
          if(m){
            const server=m[1]
            const dt=`${m[2]}-${m[3]}-${m[4]} ${m[5]}:${m[6]}:${m[7]} UTC`
            s.captureInfo=`captured on ${server} at ${dt}`
          }
        }
      }
    }catch(e){}
    // trace explorer: server dirs in HDB<instance>
    try{
      for await(const[n1,h1]of dirHandle.entries()){
        if(h1.kind!=='directory'||!/^HDB\d\d$/.test(n1))continue
        const servers=[]
        for await(const[n2,h2]of h1.entries()){if(h2.kind==='directory')servers.push({name:n2,handle:h2})}
        servers.sort((a,b)=>a.name.localeCompare(b.name))
        if(servers.length){s.traceExplorerData={instanceDir:n1,servers};break}
      }
    }catch(e){}
    fsidSessions.push(s)
    // reset rtedumps panel so it rebuilds with new FSID data
    document.getElementById('panel-rtedumps').innerHTML=''
    document.getElementById('panel-crashdumps').innerHTML=''
    renderNavTree()
    activateNavItem(sid,'topology')
  }catch(err){if(err.name!=='AbortError')alert('Error loading folder: '+err.message)}
}

// ── DOMContentLoaded ──────────────────────────────────────────────────────
document.addEventListener('DOMContentLoaded',()=>{
  // Try to load filesystem_reference.txt from disk (next to exe); overrides bundled version
  invoke('read_fs_reference').then(txt=>{if(txt)window.BUNDLED_FS_REFERENCE=txt}).catch(()=>{})
  // close context menus on outside click (mousedown fires before stopPropagation on child click handlers)
  document.addEventListener('mousedown',(e)=>{
    if(!e.target.closest('#fsid-ctx-menu'))hideFsidCtxMenu()
    if(!e.target.closest('#rte-ctx-menu'))hideRteCtxMenu()
    if(!e.target.closest('#crash-ctx-menu'))hideCrashDumpCtxMenu()
    if(!e.target.closest('#trace-line-ctx-menu'))hideTraceLineCtxMenu()
  })
  document.addEventListener('keydown',(e)=>{
    if(e.key==='Escape'){hideFsidCtxMenu();hideRteCtxMenu();hideCrashDumpCtxMenu();hideTraceLineCtxMenu()}
  })
})

// ── Nav Tree (Multi-FSID accordion) ──────────────────────────────────────
function renderNavTree(){
  const body=document.getElementById('navTreeBody')
  body.innerHTML=''
  if(!fsidSessions.length){
    const ph=document.createElement('div')
    ph.className='nav-item disabled'
    ph.innerHTML='<span class="nav-icon">📂</span>No data loaded'
    body.appendChild(ph)
    return
  }
  for(const s of fsidSessions){
    if(s.hsiParentId) continue  // child FSID — rendered inside HSI accordion
    body.appendChild(buildFsidGroup(s))
  }
}

function buildFsidGroup(s){
  if(s.type==='hsi') return buildHsiNavGroup(s)
  const hasTopology=s.topoData!=null||'topology.txt' in s.loadedFiles
  const grp=document.createElement('div')
  grp.className='fsid-group open'
  grp.dataset.sid=s.id

  // ── header ──
  const hdr=document.createElement('div')
  hdr.className='fsid-group-header'
  hdr.style.borderLeftColor=s.color
  hdr.innerHTML=`<span class="fsid-group-arrow">▶</span><span class="fsid-group-label" title="${escHtml(s.label)}">${escHtml(s.label)}<span class="fsid-group-subtitle">${escHtml(s.captureInfo)}</span></span>`
  hdr.onclick=()=>{
    grp.classList.toggle('open')
    hdr.classList.toggle('active-group',grp.classList.contains('open'))
  }
  hdr.oncontextmenu=(e)=>{
    e.preventDefault()
    showFsidCtxMenu(s.id,e.clientX,e.clientY)
  }
  grp.appendChild(hdr)

  // ── sub-items ──
  const children=document.createElement('div')
  children.className='fsid-group-children'
  const items=[
    ...(s.type!=='rtedump-single'&&hasTopology?[{icon:'🗺️',label:'Topology',panel:'topology',disabled:false}]:[]),
    ...(s.versionHistoryHandle&&s.type!=='rtedump-single'?[{icon:'📋',label:'Version History',panel:'versionhistory',disabled:false}]:[]),
    ...(s.type!=='rtedump-single'?[{icon:'⚙️',label:'Configuration',panel:'configuration',disabled:false}]:[]),
    ...(s.hostsFileHandle?[{icon:'🌐',label:'HOSTS',panel:'hosts',disabled:false}]:[]),
    ...(s.telemetryHandle?[{icon:'📡',label:'Telemetry Data',panel:'telemetry',disabled:false}]:[]),
    ...(s.nsHistoryHandles?.length?[{icon:'📈',label:'Nameserver History',panel:'nshistory',disabled:false}]:[]),
    ...(s.availabilityHandles?.length?[{icon:'🟢',label:'Availability',panel:'availability',disabled:false}]:[]),
    {icon:'💥',label:`Runtime Dumps (${s.rteDumpHandles?.length||0})`,panel:'rtedumps',disabled:false},
    ...(s.crashDumpHandles?.length?[{icon:'🛑',label:`Crash Dumps (${s.crashDumpHandles.length})`,panel:'crashdumps',disabled:false}]:[]),
    ...(s.type!=='rtedump-single'?[{icon:'📂',label:'Trace Explorer',panel:'traceexplorer',disabled:false}]:[]),
  ]
  for(const it of items){
    const sub=document.createElement('div')
    sub.className='fsid-sub-item'+(it.disabled?' disabled':'')
    sub.dataset.panel=it.panel
    sub.innerHTML=`<span style="font-size:13px;">${it.icon}</span>${it.label}`
    if(!it.disabled) sub.onclick=()=>activateNavItem(s.id,it.panel)
    children.appendChild(sub)
  }
  grp.appendChild(children)
  return grp
}

function activateNavItem(sid,panelKey){
  // Save trace explorer scroll position — only when trace explorer is the active panel
  if(activePanel==='traceexplorer' && traceExplState && traceExplState.sid===activeFsidId){
    const list=document.querySelector('#panel-traceexplorer .trace-list')
    if(list) traceExplState.scrollTop=list.scrollTop
  }
  // HSI sessions have their own activation flow
  const s=sess(sid)
  if(s&&s.type==='hsi'){
    const tabs=hsiGetTabList(s)
    const lastId=s._hsiLastTabId
    const target=tabs.find(t=>t.id===lastId)||tabs[0]
    if(target) activateHsiTab(sid, target.id, target.id===lastId ? s._hsiLastSubTabId : null)
    return
  }
  // switch active session
  if(activeFsidId!==sid){
    activeFsidId=sid
    // clear panels that hold session-specific content
    Object.values(_nsChartState).forEach(st=>{if(st?.chart){st.chart.destroy();st.chart=null}})
    document.getElementById('panel-topology').innerHTML=''
    document.getElementById('panel-versionhistory').innerHTML=''
    document.getElementById('panel-configuration').innerHTML=''
    document.getElementById('panel-telemetry').innerHTML=''
    document.getElementById('panel-nshistory').innerHTML=''
    document.getElementById('panel-availability').innerHTML=''
    document.getElementById('panel-rtedumps').innerHTML=''
    document.getElementById('panel-crashdumps').innerHTML=''
    document.getElementById('panel-hosts').innerHTML=''
    document.getElementById('panel-traceexplorer').innerHTML=''
  }
  activePanel=panelKey
  // highlight in nav
  document.getElementById('navTreeBody').querySelectorAll('.fsid-sub-item').forEach(i=>i.classList.remove('active'))
  const grp=document.getElementById('navTreeBody').querySelector(`.fsid-group[data-sid="${sid}"]`)
  if(grp){
    const sub=grp.querySelector(`[data-panel="${panelKey}"]`)
    if(sub){
      sub.classList.add('active')
      sub.style.borderLeftColor=fsidSessions.find(s=>s.id===sid)?.color||'#0078D4'
    }
    // ensure group is open
    if(!grp.classList.contains('open'))grp.classList.add('open')
  }
  // render content
  activateNav(null,panelKey)
}

// ── Context menu ──────────────────────────────────────────────────────────
function showFsidCtxMenu(sid,x,y){
  ctxTargetId=sid
  const m=document.getElementById('fsid-ctx-menu')
  m.style.display='block'
  m.style.left=x+'px'
  m.style.top=y+'px'
  // keep in viewport
  requestAnimationFrame(()=>{
    const r=m.getBoundingClientRect()
    if(r.right>window.innerWidth)m.style.left=(x-r.width)+'px'
    if(r.bottom>window.innerHeight)m.style.top=(y-r.height)+'px'
  })
}
function hideFsidCtxMenu(){
  document.getElementById('fsid-ctx-menu').style.display='none'
  ctxTargetId=null
}
function showRteCtxMenu(idx,x,y){
  _rteCtxIdx=idx
  const m=document.getElementById('rte-ctx-menu')
  m.style.display='block'
  m.style.left=x+'px'
  m.style.top=y+'px'
  requestAnimationFrame(()=>{
    const r=m.getBoundingClientRect()
    if(r.right>window.innerWidth)m.style.left=(x-r.width)+'px'
    if(r.bottom>window.innerHeight)m.style.top=(y-r.height)+'px'
  })
}
function hideRteCtxMenu(){
  const m=document.getElementById('rte-ctx-menu')
  if(m)m.style.display='none'
  _rteCtxIdx=null
}
let _traceLineCtxOrigIdx=null
function showTraceLineCtxMenu(origIdx,x,y){
  _traceLineCtxOrigIdx=origIdx
  const m=document.getElementById('trace-line-ctx-menu')
  if(!m)return
  m.style.display='block'
  m.style.left=x+'px'
  m.style.top=y+'px'
  requestAnimationFrame(()=>{
    const r=m.getBoundingClientRect()
    if(r.right>window.innerWidth)m.style.left=(x-r.width)+'px'
    if(r.bottom>window.innerHeight)m.style.top=(y-r.height)+'px'
  })
}
function hideTraceLineCtxMenu(){
  const m=document.getElementById('trace-line-ctx-menu')
  if(m)m.style.display='none'
  _traceLineCtxOrigIdx=null
}
function traceJumpToOrigLine(){
  const origIdx=_traceLineCtxOrigIdx
  hideTraceLineCtxMenu()
  if(origIdx==null)return
  traceClearFilter()
  requestAnimationFrame(()=>{
    const list=document.getElementById('trace-list')
    if(list)list.scrollTop=origIdx*_TRACE_LH-list.clientHeight/2+_TRACE_LH/2
  })
}
function rteDumpOpenInAnalyzer(){
  const idx=_rteCtxIdx
  hideRteCtxMenu()
  const d=rteDumpHandles[idx]
  if(!d){console.error('rteDumpOpenInAnalyzer: no handle for idx',idx);return}
  const path=d.handle?._path
  if(!path){alert('File path not available.');return}
  console.log('Opening in HanaDumpAnalyzer:',path)
  if(window.__TAURI__?.core?.invoke){
    window.__TAURI__.core.invoke('open_in_dump_analyzer',{dumpPath:path})
      .catch(e=>alert('Could not start HanaDumpAnalyzer:\n'+e))
  } else {
    alert('Tauri not available.')
  }
}
function fsidCtxRename(){
  const s=sess(ctxTargetId);if(!s){hideFsidCtxMenu();return}
  const newName=prompt('Rename FSID entry:',s.label)
  if(newName&&newName.trim()){s.label=newName.trim();renderNavTree()}
  hideFsidCtxMenu()
}
function fsidCtxRemove(){
  const s=sess(ctxTargetId);if(!s){hideFsidCtxMenu();return}
  if(!confirm(`Remove "${s.label}" from the list?`)){hideFsidCtxMenu();return}
  // also remove child FSID sessions if this is an HSI session
  const toRemove=new Set([ctxTargetId])
  if(s.type==='hsi') fsidSessions.filter(x=>x.hsiParentId===ctxTargetId).forEach(x=>toRemove.add(x.id))
  fsidSessions=fsidSessions.filter(x=>!toRemove.has(x.id))
  if(toRemove.has(activeFsidId)){
    activeFsidId=fsidSessions.length?fsidSessions[fsidSessions.length-1].id:null
    Object.values(_nsChartState).forEach(st=>{if(st?.chart){st.chart.destroy();st.chart=null}})
    ;['panel-topology','panel-versionhistory','panel-configuration','panel-telemetry','panel-nshistory','panel-availability','panel-rtedumps','panel-crashdumps','panel-hosts','panel-traceexplorer','panel-hsi'].forEach(id=>{const el=document.getElementById(id);if(el){el.innerHTML='';el.style.display='';el.classList.remove('active')}})
    document.getElementById('empty').style.display=fsidSessions.length?'none':'flex'
  }
  hideFsidCtxMenu()
  renderNavTree()
  if(activeFsidId){const _s=sess(activeFsidId);const _defPanel=_s&&(_s.topoData!=null||'topology.txt' in(_s.loadedFiles||{}))?'topology':'configuration';activateNavItem(activeFsidId,_defPanel)}
}

// ── activateNav: renders content for the active session ───────────────────
async function activateNav(clickedItem,panelKey){
  // hide HSI panel when switching to a regular FSID panel
  const hsiPanel=document.getElementById('panel-hsi')
  if(hsiPanel){hsiPanel.style.display='none';hsiPanel.classList.remove('active')}
  document.getElementById('empty').style.display='none'
  document.querySelectorAll('.content-panel').forEach(p=>{p.classList.remove('active');p.style.display=''})

  if(panelKey==='topology'){
    const panel=document.getElementById('panel-topology')
    panel.classList.add('active')
    const s=activeSess()
    // if we already have parsed topoData for this session, reuse it
    if(s&&s.topoData){renderTopologyApp(s.topoData,panel);return}
    if(!s||!('topology.txt' in s.loadedFiles)){
      panel.innerHTML='<div class="not-found-msg"><span class="nf-icon">⚠️</span><span>No <strong>topology.txt</strong> found in this FSID folder.</span></div>'
      return
    }
    panel.innerHTML='<div style="padding:16px;color:#A19F9D;font-size:12px;">Loading topology.txt…</div>'
    try{
      const file=await s.loadedFiles['topology.txt'].getFile()
      const content=await file.text()
      const data=parseTopology(content)
      s.topoData=data
      renderTopologyApp(data,panel)
    }catch(e){panel.innerHTML=`<div class="not-found-msg"><span class="nf-icon">⚠️</span><span>Error: ${escHtml(String(e))}</span></div>`}
  }

  if(panelKey==='versionhistory'){
    const panel=document.getElementById('panel-versionhistory')
    panel.classList.add('active')
    panel.innerHTML='<div style="padding:16px;"></div>'
    const wrap=panel.firstChild
    const s=activeSess()
    if(!s?.versionHistoryHandle){wrap.innerHTML='<div class="not-found-msg"><span class="nf-icon">⚠️</span><span>No <strong>versionhistory.csv</strong> found at <code>SYS/global/hdb/versionhistory.csv</code>.</span></div>';return}
    try{const file=await s.versionHistoryHandle.getFile();const text=await file.text();wrap.innerHTML=renderVersionHistory(text)}
    catch(e){wrap.innerHTML=`<div class="not-found-msg"><span class="nf-icon">⚠️</span><span>Error: ${escHtml(String(e))}</span></div>`}
  }

  if(panelKey==='configuration'){
    const panel=document.getElementById('panel-configuration')
    panel.classList.add('active')
    panel.innerHTML='<div style="padding:16px;"></div>'
    const wrap=panel.firstChild
    const s=activeSess()
    if(!s?.configDirHandle){
      wrap.innerHTML='<div class="not-found-msg"><span class="nf-icon">⚠️</span><span>No <strong>config</strong> directory found at <code>SYS/global/hdb/custom/config/</code>.</span></div>'
      return
    }
    if(!s.configViewMode) s.configViewMode='explained'
    // If already loaded, render directly
    if(s.configFileHandles.length){
      wrap.innerHTML='<div style="color:#A19F9D;font-size:12px;">Loading…</div>'
      await renderConfigContent(s,wrap)
      return
    }
    // In Tauri, .ini files are accessible directly — scan without picker
    wrap.innerHTML='<div style="color:#A19F9D;font-size:12px;">Loading…</div>'
    await scanConfigDir(s)
    s._configScanned=true
    if(!s.configFileHandles.length){
      wrap.innerHTML='<div class="not-found-msg"><span class="nf-icon">⚠️</span><span>No <strong>.ini files</strong> found in <code>config/</code>.</span></div>'
      return
    }
    await renderConfigContent(s,wrap)
  }

  if(panelKey==='hosts'){
    const panel=document.getElementById('panel-hosts')
    panel.classList.add('active')
    panel.innerHTML='<div style="padding:16px;"></div>'
    const wrap=panel.firstChild
    const s=activeSess()
    if(!s?.hostsFileHandle){
      wrap.innerHTML='<div class="not-found-msg"><span class="nf-icon">⚠️</span><span>No <strong>hosts</strong> file found at <code>etc/hosts</code>.</span></div>'
      return
    }
    try{
      const file=await s.hostsFileHandle.getFile()
      const text=await file.text()
      wrap.innerHTML=`<div class="card"><div class="card-title">🌐 etc/hosts</div><div class="card-body"><pre style="margin:0;padding:0;white-space:pre;font-family:monospace;font-size:0.92em;line-height:1.4;color:#000;overflow-x:auto;">${escHtml(text)}</pre></div></div>`
    }catch(e){
      wrap.innerHTML=`<div class="not-found-msg"><span class="nf-icon">⚠️</span><span>Error: ${escHtml(String(e))}</span></div>`
    }
  }

  if(panelKey==='telemetry'){
    const panel=document.getElementById('panel-telemetry')
    panel.classList.add('active')
    panel.innerHTML='<div style="padding:16px;"></div>'
    const wrap=panel.firstChild
    const s=activeSess()
    if(!s?.telemetryHandle){
      wrap.innerHTML='<div class="not-found-msg"><span class="nf-icon">⚠️</span><span>No <strong>telemetryData.csv</strong> found in this FSID folder.</span></div>'
      return
    }
    try{
      const file=await s.telemetryHandle.getFile()
      const text=await file.text()
      wrap.innerHTML=renderTelemetry(text)
    }catch(e){wrap.innerHTML=`<div class="not-found-msg"><span class="nf-icon">⚠️</span><span>Error: ${escHtml(String(e))}</span></div>`}
  }

  if(panelKey==='nshistory'){
    const panel=document.getElementById('panel-nshistory')
    panel.classList.add('active')
    panel.innerHTML=''
    const s=activeSess()
    nsChartPanel(panel,s)
  }

  if(panelKey==='availability'){
    const panel=document.getElementById('panel-availability')
    panel.classList.add('active')
    panel.innerHTML=''
    const s=activeSess()
    if(!s?.availabilityHandles?.length){
      panel.innerHTML='<div class="not-found-msg" style="margin:16px;"><span class="nf-icon">⚠️</span><span>No <strong>system_availability_*.trc</strong> found at <code>HDB&lt;inst&gt;/&lt;host&gt;/trace/</code>.</span></div>'
      return
    }
    const tabBar=document.createElement('div')
    tabBar.style.cssText='display:flex;border-bottom:1px solid #EDEBE9;background:#F3F2F1;padding:0 12px;overflow-x:auto;white-space:nowrap;position:sticky;top:0;z-index:10;'
    panel.appendChild(tabBar)
    const contentDiv=document.createElement('div')
    contentDiv.style.cssText='padding:16px;'
    panel.appendChild(contentDiv)
    const showHost=async(idx)=>{
      tabBar.querySelectorAll('button').forEach((b,i)=>{b.style.fontWeight=i===idx?'600':'400';b.style.borderBottom=i===idx?'2px solid #0078D4':'2px solid transparent';b.style.color=i===idx?'#0078D4':'#605E5C'})
      contentDiv.innerHTML='<div style="color:#A19F9D;font-size:12px;">Loading…</div>'
      const {hostName,handle}=s.availabilityHandles[idx]
      try{
        const file=await handle.getFile()
        contentDiv.innerHTML=renderAvailability(await file.text(),hostName,file.name)
      }catch(e){contentDiv.innerHTML=`<div class="not-found-msg"><span class="nf-icon">⚠️</span><span>Error: ${escHtml(String(e))}</span></div>`}
    }
    s.availabilityHandles.forEach(({hostName},idx)=>{
      const btn=document.createElement('button')
      btn.style.cssText='height:34px;padding:0 14px;border:none;border-bottom:2px solid transparent;background:transparent;font-family:inherit;font-size:12px;color:#605E5C;cursor:pointer;white-space:nowrap;margin-bottom:-1px;'
      btn.textContent=hostName
      btn.onclick=()=>showHost(idx)
      tabBar.appendChild(btn)
    })
    await showHost(0)
  }

  if(panelKey==='rtedumps'){
    const panel=document.getElementById('panel-rtedumps')
    panel.classList.add('active')
    panel.innerHTML=''
    const topRow=document.createElement('div')
    topRow.style.cssText='display:flex;align-items:center;border-bottom:1px solid #EDEBE9;background:#F3F2F1;flex-shrink:0;'
    const tabBar=document.createElement('div')
    tabBar.id='rte-tabbar'
    tabBar.style.cssText='display:flex;flex:1;padding:0 12px;overflow-x:auto;white-space:nowrap;'
    topRow.appendChild(tabBar)
    panel.appendChild(topRow)
    const tabContent=document.createElement('div')
    tabContent.id='rte-tabcontent'
    tabContent.style.cssText='flex:1;overflow-y:auto;'
    panel.appendChild(tabContent)
    const s=activeSess()
    const dumps=s?.rteDumpHandles||[]
    const scanned=s?.rteDumpScannedPaths||[]
    if(dumps.length){
      const overviewBtn=document.createElement('button')
      overviewBtn.dataset.rteid='overview'
      overviewBtn.style.cssText='display:inline-flex;align-items:center;gap:5px;height:36px;padding:0 14px;border:none;border-bottom:2px solid transparent;background:transparent;font-family:inherit;font-size:12px;color:#605E5C;cursor:pointer;white-space:nowrap;'
      overviewBtn.innerHTML='💥 Overview'
      overviewBtn.onclick=()=>rteTabSwitch('overview')
      tabBar.appendChild(overviewBtn)
      const overviewPanel=document.createElement('div')
      overviewPanel.dataset.rtepanel='overview'
      overviewPanel.style.cssText='padding:16px;'
      overviewPanel.innerHTML=renderRteDumps(dumps,scanned)
      tabContent.appendChild(overviewPanel)
      const knowledgeBtn=document.createElement('button')
      knowledgeBtn.dataset.rteid='knowledge'
      knowledgeBtn.style.cssText='display:inline-flex;align-items:center;gap:5px;height:36px;padding:0 14px;border:none;border-bottom:2px solid transparent;background:transparent;font-family:inherit;font-size:12px;color:#605E5C;cursor:pointer;white-space:nowrap;'
      knowledgeBtn.innerHTML='📚 Knowledge'
      knowledgeBtn.onclick=()=>rteTabSwitch('knowledge')
      tabBar.appendChild(knowledgeBtn)
      const knowledgePanel=document.createElement('div')
      knowledgePanel.dataset.rtepanel='knowledge'
      knowledgePanel.style.cssText='display:none;padding:16px;'
      knowledgePanel.innerHTML=renderRteDumpKnowledge()
      tabContent.appendChild(knowledgePanel)
      rteTabSwitch('overview')
    } else {
      const infoPanel=document.createElement('div')
      infoPanel.dataset.rtepanel='overview'
      infoPanel.style.display='block'
      const pathList=scanned.length?scanned.map(p=>`<code>${escHtml(p)}</code>`).join(', '):s?s.rteDumpHdbFound?'<em>no .rtedump files found in this FSID</em>':'<em>no HDB&lt;instance&gt; directory found</em>':'<em>no FSID loaded</em>'
      infoPanel.innerHTML=`<div class="not-found-msg" style="margin:16px;"><span class="nf-icon">⚠️</span><span>No runtime dump files found. Scanned: ${pathList} &nbsp;— use <strong>Load dump file</strong> to open a single file.</span></div>`
      tabContent.appendChild(infoPanel)
      const knowledgeBtn=document.createElement('button')
      knowledgeBtn.dataset.rteid='knowledge'
      knowledgeBtn.style.cssText='display:inline-flex;align-items:center;gap:5px;height:36px;padding:0 14px;border:none;border-bottom:2px solid transparent;background:transparent;font-family:inherit;font-size:12px;color:#605E5C;cursor:pointer;white-space:nowrap;'
      knowledgeBtn.innerHTML='📚 Knowledge'
      knowledgeBtn.onclick=()=>rteTabSwitch('knowledge')
      tabBar.appendChild(knowledgeBtn)
      const knowledgePanel=document.createElement('div')
      knowledgePanel.dataset.rtepanel='knowledge'
      knowledgePanel.style.cssText='display:none;padding:16px;'
      knowledgePanel.innerHTML=renderRteDumpKnowledge()
      tabContent.appendChild(knowledgePanel)
    }
  }

  if(panelKey==='crashdumps'){
    const panel=document.getElementById('panel-crashdumps')
    panel.classList.add('active')
    panel.innerHTML=''
    const topRow=document.createElement('div')
    topRow.style.cssText='display:flex;align-items:center;border-bottom:1px solid #EDEBE9;background:#F3F2F1;flex-shrink:0;'
    const tabBar=document.createElement('div')
    tabBar.id='crash-tabbar'
    tabBar.style.cssText='display:flex;flex:1;padding:0 12px;overflow-x:auto;white-space:nowrap;'
    topRow.appendChild(tabBar);panel.appendChild(topRow)
    const tabContent=document.createElement('div')
    tabContent.id='crash-tabcontent'
    tabContent.style.cssText='flex:1;overflow-y:auto;'
    panel.appendChild(tabContent)
    const s=activeSess()
    const dumps=s?.crashDumpHandles||[]
    const scanned=s?.rteDumpScannedPaths||[]
    const overviewBtn=document.createElement('button')
    overviewBtn.dataset.crashid='overview'
    overviewBtn.style.cssText='display:inline-flex;align-items:center;gap:5px;height:36px;padding:0 14px;border:none;border-bottom:2px solid transparent;background:transparent;font-family:inherit;font-size:12px;color:#605E5C;cursor:pointer;white-space:nowrap;'
    overviewBtn.innerHTML='🛑 Overview'
    overviewBtn.onclick=()=>crashTabSwitch('overview')
    tabBar.appendChild(overviewBtn)
    const overviewPanel=document.createElement('div')
    overviewPanel.dataset.crashpanel='overview'
    overviewPanel.style.cssText='padding:16px;'
    overviewPanel.innerHTML=dumps.length?renderCrashDumps(dumps,scanned):`<div class="not-found-msg" style="margin:16px;"><span class="nf-icon">⚠️</span><span>No crash dump files found.</span></div>`
    tabContent.appendChild(overviewPanel)
    crashTabSwitch('overview')
  }

  if(panelKey==='traceexplorer'){
    const panel=document.getElementById('panel-traceexplorer')
    panel.classList.add('active')
    const s=activeSess()
    if(!s?.traceExplorerData){
      panel.innerHTML='<div class="not-found-msg" style="margin:16px;"><span class="nf-icon">⚠️</span><span>No <strong>HDB&lt;instance&gt;</strong> directory found in this FSID folder.</span></div>'
      return
    }
    if(s.traceExplState){
      // Restore saved state for this session
      traceExplState=s.traceExplState
      traceExplState._pendingScrollRestore=traceExplState.scrollTop||0
      traceRender(panel,s)
    } else {
      traceExplState={sid:s.id,serverIdx:0,stack:[],entries:[],viewingFile:null,sortCol:'name',sortDir:'asc',scrollTop:0,serverStates:{}}
      s.traceExplState=traceExplState
      traceRender(panel,s)
    }
  }
}

// ── Trace Explorer helpers ─────────────────────────────────────────────────
function formatBytes(b){
  if(b==null)return ''
  if(b<1024)return b+' B'
  if(b<1048576)return (b/1024).toFixed(1)+' KB'
  if(b<1073741824)return (b/1048576).toFixed(1)+' MB'
  return (b/1073741824).toFixed(2)+' GB'
}

function traceFileIcon(name){
  const ext=name.split('.').pop().toLowerCase()
  if(['trc','log','txt','out','err'].includes(ext))return '📄'
  if(['gz','zip','tar','bz2'].includes(ext))return '🗜️'
  if(['py','sh','sql','js'].includes(ext))return '📝'
  if(['csv','tsv'].includes(ext))return '📊'
  if(['json','xml','ini','cfg'].includes(ext))return '⚙️'
  return '📄'
}

// Groups split .trc files (e.g. indexserver_host.port.031.trc → combined)
// Excludes .rtedump. files. Returns new entry array with combined virtual entries.
function traceGroupCombinedFiles(entries){
  const pattern=/^(.+)\.(\d{3,})\.(trc|csv)$/i
  const groups=new Map()
  const result=[]
  for(const e of entries){
    if(e.isDir){result.push(e);continue}
    const m=e.name.match(pattern)
    if(!m){result.push(e);continue}
    const base=m[1], seq=parseInt(m[2],10), ext=m[3].toLowerCase()
    const key=base+'.'+ext
    if(!groups.has(key))groups.set(key,{base,ext,parts:[]})
    groups.get(key).parts.push({entry:e,seq})
  }
  for(const[,g]of groups){
    const{base,ext,parts}=g
    if(parts.length<2){result.push(parts[0].entry);continue}
    parts.sort((a,b)=>a.seq-b.seq)
    const handles=parts.map(p=>p.entry.handle)
    const totalSize=parts.reduce((s,p)=>s+(p.entry.size||0),0)
    const lastMod=Math.max(...parts.map(p=>p.entry.lastModified||0))
    const combinedName=base+'.combined.'+ext
    const combinedHandle=window.CombinedFileHandle
      ?new window.CombinedFileHandle(combinedName,handles)
      :handles[0]
    result.push({name:combinedName,isDir:false,isCombined:true,
      handle:combinedHandle,size:totalSize,lastModified:lastMod,partCount:parts.length})
  }
  return result
}

async function traceRender(panel,s){
  const data=s.traceExplorerData
  if(!data)return
  panel.innerHTML=''

  // ── tab bar ──
  const tabBar=document.createElement('div')
  tabBar.style.cssText='display:flex;border-bottom:1px solid #EDEBE9;background:#F3F2F1;padding:0 12px;overflow-x:auto;white-space:nowrap;flex-shrink:0;'
  panel.appendChild(tabBar)

  data.servers.forEach((srv,idx)=>{
    const btn=document.createElement('button')
    btn.style.cssText='display:inline-flex;align-items:center;gap:5px;height:36px;padding:0 14px;border:none;border-bottom:2px solid transparent;background:transparent;font-family:inherit;font-size:12px;cursor:pointer;white-space:nowrap;'
    btn.textContent=srv.name
    btn.dataset.idx=idx
    if(idx===traceExplState.serverIdx){
      btn.style.color='#0078D4'; btn.style.fontWeight='700'; btn.style.borderBottomColor='#0078D4'
    } else {
      btn.style.color='#605E5C'
    }
    btn.onclick=()=>traceSelectServer(idx)
    tabBar.appendChild(btn)
  })

  // ── breadcrumb ──
  const bc=document.createElement('div')
  bc.id='trace-breadcrumb'
  bc.className='trace-breadcrumb'
  panel.appendChild(bc)

  // ── file list ──
  const list=document.createElement('div')
  list.id='trace-list'
  list.className='trace-list'
  panel.appendChild(list)

  await traceLoadDir()
}

async function traceSelectServer(idx){
  if(!traceExplState)return
  const oldIdx=traceExplState.serverIdx
  if(!traceExplState.serverStates)traceExplState.serverStates={}
  // Save current server state before switching
  traceExplState.serverStates[oldIdx]={
    stack:[...traceExplState.stack],
    viewingFile:traceExplState.viewingFile,
    entries:[...(traceExplState.entries||[])],
    sortCol:traceExplState.sortCol,
    sortDir:traceExplState.sortDir,
    scrollTop:traceExplState.scrollTop
  }
  // Restore saved state for target server (or reset to root)
  const saved=traceExplState.serverStates[idx]
  if(saved){
    traceExplState.stack=saved.stack
    traceExplState.viewingFile=saved.viewingFile
    traceExplState.entries=saved.entries
    traceExplState.sortCol=saved.sortCol
    traceExplState.sortDir=saved.sortDir
    traceExplState.scrollTop=saved.scrollTop
  }else{
    traceExplState.stack=[]
    traceExplState.viewingFile=null
    traceExplState.entries=[]
    traceExplState.sortCol='name'
    traceExplState.sortDir='asc'
    traceExplState.scrollTop=0
  }
  traceExplState.serverIdx=idx
  const panel=document.getElementById('panel-traceexplorer')
  const s=sess(traceExplState.sid)
  if(s) await traceRender(panel,s)
}

async function traceLoadDir(){
  if(!traceExplState)return
  const s=sess(traceExplState.sid)
  if(!s?.traceExplorerData)return
  if(traceExplState.viewingFile){
    const vfName=traceExplState.viewingFile.name.toLowerCase()
    const isTabular=vfName.endsWith('.csv')
    if(isTabular)await traceShowCsvView(s)
    else await traceShowFileView(s)
    return
  }
  const data=s.traceExplorerData
  const srv=data.servers[traceExplState.serverIdx]

  let handle=srv.handle
  for(const frame of traceExplState.stack){handle=frame.handle}

  const dirs=[], files=[]
  try{
    for await(const[name,h]of handle.entries()){
      if(h.kind==='directory')dirs.push({name,handle:h,isDir:true,size:null,lastModified:null})
      else files.push({name,handle:h,isDir:false,size:null,lastModified:null})
    }
  }catch(e){
    document.getElementById('trace-list').innerHTML=`<div style="padding:16px;color:#A19F9D;font-size:12px;">Error: ${escHtml(String(e))}</div>`
    return
  }
  // load file metadata concurrently
  await Promise.all(files.map(async f=>{
    try{const file=await f.handle.getFile();f.size=file.size;f.lastModified=file.lastModified}catch(e){}
  }))
  traceExplState.entries=[...dirs,...files]

  // breadcrumb
  const bc=document.getElementById('trace-breadcrumb')
  if(bc){
    const atRoot=traceExplState.stack.length===0
    if(atRoot){
      let html=`<span class="trace-crumb-root">${escHtml(data.instanceDir)}</span>`
      html+=`<span class="trace-crumb-sep">/</span><span class="trace-crumb-cur">${escHtml(srv.name)}</span>`
      bc.innerHTML=html
    } else {
      let html=`<a class="trace-crumb-link" href="#" onclick="traceNavigateUp(0);return false;">${escHtml(data.instanceDir)}</a>`
      html+=`<span class="trace-crumb-sep">/</span><a class="trace-crumb-link" href="#" onclick="traceNavigateUp(0);return false;">${escHtml(srv.name)}</a>`
      traceExplState.stack.forEach((frame,depth)=>{
        html+=`<span class="trace-crumb-sep">/</span>`
        if(depth<traceExplState.stack.length-1){
          html+=`<a class="trace-crumb-link" href="#" onclick="traceNavigateUp(${depth+1});return false;">${escHtml(frame.name)}</a>`
        } else {
          html+=`<span class="trace-crumb-cur">${escHtml(frame.name)}</span>`
        }
      })
      bc.innerHTML=html
    }
  }
  traceRenderDirList()
}

function traceRenderDirList(){
  const list=document.getElementById('trace-list')
  if(!list)return
  list.innerHTML=''

  if(traceExplState.stack.length>0){
    const up=document.createElement('div')
    up.className='trace-entry'
    up.innerHTML=`<span class="trace-icon">⬆️</span><span class="trace-name">..</span>`
    up.onclick=()=>traceNavigateUp(traceExplState.stack.length-1)
    list.appendChild(up)
  }

  if(traceExplState.entries.length===0){
    list.innerHTML+='<div style="padding:16px;color:#A19F9D;font-size:12px;font-style:italic;">Empty directory</div>'
    return
  }

  // column header
  const sc=traceExplState.sortCol, sd=traceExplState.sortDir, arr=sd==='asc'?' ▲':' ▼'
  const hdr=document.createElement('div')
  hdr.className='trace-header'
  hdr.innerHTML=
    `<span></span>`+
    `<span class="trace-header-cell" onclick="traceSort('name')">Name${sc==='name'?arr:''}</span>`+
    `<span class="trace-header-cell" onclick="traceSort('modified')">Date Modified${sc==='modified'?arr:''}</span>`+
    `<span class="trace-header-cell" style="text-align:right;" onclick="traceSort('size')">Size${sc==='size'?arr:''}</span>`
  list.appendChild(hdr)

  // .rtedump. files → Runtime Dumps panel; .crashdump. → Crash Dumps panel; nameserver_history.trc + system_availability_*.trc → dedicated nav items
  const rawFiles=traceExplState.entries.filter(e=>{
    if(e.isDir)return false
    const n=e.name.toLowerCase()
    if(n.includes('.rtedump.'))return false
    if(n.includes('.crashdump.'))return false
    if(n==='nameserver_history.trc')return false
    if(n.startsWith('system_availability_')&&n.endsWith('.trc'))return false
    return true
  })
  const groupedFiles=traceGroupCombinedFiles(rawFiles)
  const sorted=[
    ...[...traceExplState.entries.filter(e=>e.isDir)].sort((a,b)=>traceSortCmp(a,b,sc,sd)),
    ...[...groupedFiles].sort((a,b)=>traceSortCmp(a,b,sc,sd))
  ]

  sorted.forEach(e=>{
    const row=document.createElement('div')
    row.className='trace-entry has-cols'
    const mod=e.lastModified?new Date(e.lastModified).toLocaleString('de-DE',{year:'2-digit',month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit'}):''
    const nameHtml=e.isCombined
      ?`${escHtml(e.name)} <span style="color:#A19F9D;font-size:10px;">(${e.partCount} parts)</span>`
      :escHtml(e.name)
    const icon=e.isDir?'📁':e.isCombined?'🔗':traceFileIcon(e.name)
    row.innerHTML=
      `<span class="trace-icon">${icon}</span>`+
      `<span class="trace-name">${nameHtml}</span>`+
      `<span class="trace-col-modified">${mod}</span>`+
      `<span class="trace-col-size">${e.isDir?'':formatBytes(e.size)}</span>`
    if(e.isDir){
      const origIdx=traceExplState.entries.indexOf(e)
      row.onclick=()=>traceNavigateInto(origIdx)
    } else {
      row.onclick=()=>traceOpenFileEntry(e)
    }
    list.appendChild(row)
  })
  if(traceExplState._pendingScrollRestore!=null){
    const sv=traceExplState._pendingScrollRestore
    traceExplState._pendingScrollRestore=null
    requestAnimationFrame(()=>{list.scrollTop=sv})
  }
}

function traceSortCmp(a,b,col,dir){
  const d=dir==='asc'?1:-1
  if(col==='name') return d*a.name.localeCompare(b.name)
  if(col==='modified') return d*((a.lastModified||0)-(b.lastModified||0))
  if(col==='size') return d*((a.size||0)-(b.size||0))
  return 0
}

function traceSort(col){
  if(!traceExplState)return
  traceExplState.sortDir=traceExplState.sortCol===col&&traceExplState.sortDir==='asc'?'desc':'asc'
  traceExplState.sortCol=col
  traceRenderDirList()
}

async function traceNavigateInto(idx){
  if(!traceExplState)return
  const e=traceExplState.entries[idx]
  if(!e||!e.isDir)return
  traceExplState.stack.push({name:e.name,handle:e.handle})
  await traceLoadDir()
}

async function traceNavigateUp(depth){
  if(!traceExplState)return
  traceExplState.viewingFile=null
  traceExplState.stack=traceExplState.stack.slice(0,depth)
  await traceLoadDir()
}

async function traceOpenFile(idx){
  if(!traceExplState)return
  const e=traceExplState.entries[idx]
  if(!e||e.isDir)return
  await traceOpenFileEntry(e)
}

async function traceOpenFileEntry(e){
  if(!traceExplState||!e||e.isDir)return
  traceExplState.viewingFile={name:e.name,handle:e.handle,offset:0,fileSize:0}
  await traceLoadDir()
}

async function traceCloseFile(){
  if(!traceExplState)return
  traceExplState.viewingFile=null
  await traceLoadDir()
}

function renderCsvTable(text,name){
  const allLines=text.split('\n').map(l=>l.replace(/\r$/,'')).filter(l=>l.trim())
  if(!allLines.length)return '<div class="not-found-msg"><span class="nf-icon">⚠️</span><span>CSV is empty or has no data rows.</span></div>'
  // Separate leading #-comment / metadata lines (e.g. "#1;2024-08-18 19:18:02.384000")
  let li=0
  const metaLines=[]
  while(li<allLines.length&&allLines[li].startsWith('#'))metaLines.push(allLines[li++])
  const dataLines=allLines.slice(li)
  if(!dataLines.length)return '<div class="not-found-msg"><span class="nf-icon">⚠️</span><span>CSV is empty or has no data rows.</span></div>'
  const sep=dataLines[0].includes(';')?';':','
  let headers,rows
  if(metaLines.length){
    // No header row — determine column count from first 10 data rows (ignore trailing empty cells)
    const maxCols=Math.max(...dataLines.slice(0,10).map(l=>{
      const p=l.split(sep);let n=p.length;while(n>0&&p[n-1]==='')n--;return n
    }))
    headers=Array.from({length:maxCols},(_,i)=>`Col ${i+1}`)
    rows=dataLines
  }else{
    headers=dataLines[0].split(sep)
    rows=dataLines.slice(1).filter(l=>l!==dataLines[0])
  }
  const metaNote=metaLines.length?`<span style="font-size:10px;color:#A19F9D;margin-left:8px;">${escHtml(metaLines.join(' | '))}</span>`:''
  let html=`<div class="card"><div class="card-title">📊 ${escHtml(name)} <span style="font-weight:400;font-size:11px;color:#605E5C;">${rows.length.toLocaleString()} rows</span>${metaNote}</div>`+
    `<div style="overflow-x:auto;max-height:calc(100vh - 160px);overflow-y:auto;">`+
    `<table class="data-table" style="white-space:nowrap;width:auto;min-width:100%;">`+
    `<thead style="position:sticky;top:0;z-index:5;"><tr>`
  for(const h of headers)html+=`<th>${escHtml(h)}</th>`
  html+=`</tr></thead><tbody>`
  for(const row of rows){
    const cells=row.split(sep)
    html+='<tr>'
    for(let i=0;i<headers.length;i++)html+=`<td><span class="mono">${escHtml(cells[i]??'')}</span></td>`
    html+='</tr>'
  }
  html+=`</tbody></table></div></div>`
  return html
}

async function traceShowCsvView(s){
  const data=s.traceExplorerData
  const srv=data.servers[traceExplState.serverIdx]
  const vf=traceExplState.viewingFile
  const bc=document.getElementById('trace-breadcrumb')
  if(bc){
    let html=`<a class="trace-crumb-link" href="#" onclick="traceNavigateUp(0);return false;">${escHtml(data.instanceDir)}</a>`
    html+=`<span class="trace-crumb-sep">/</span><a class="trace-crumb-link" href="#" onclick="traceNavigateUp(0);return false;">${escHtml(srv.name)}</a>`
    traceExplState.stack.forEach((frame,depth)=>{
      html+=`<span class="trace-crumb-sep">/</span>`
      html+=`<a class="trace-crumb-link" href="#" onclick="traceNavigateUp(${depth+1});return false;">${escHtml(frame.name)}</a>`
    })
    html+=`<span class="trace-crumb-sep">/</span>`
    html+=`<span class="trace-crumb-cur" style="user-select:text;cursor:text;">${escHtml(vf.name)}</span>`
    _traceCopyPath=vf.handle?._path||vf.name
    html+=`<button onclick="traceCopyBreadcrumbPath(this)" title="Copy full path to clipboard" style="margin-left:6px;background:none;border:none;cursor:pointer;font-size:12px;padding:1px 4px;color:#A19F9D;border-radius:2px;line-height:1;" onmouseenter="this.style.color='#323130'" onmouseleave="this.style.color='#A19F9D'">📋</button>`
    bc.innerHTML=html
  }
  const list=document.getElementById('trace-list')
  if(!list)return
  list.innerHTML=''
  const up=document.createElement('div')
  up.className='trace-entry'
  up.innerHTML=`<span class="trace-icon">⬆️</span><span class="trace-name">..</span>`
  up.onclick=()=>traceCloseFile()
  list.appendChild(up)
  const loading=document.createElement('div')
  loading.style.cssText='padding:16px;color:#605E5C;font-size:12px;'
  loading.textContent='Loading…'
  list.appendChild(loading)
  try{
    const file=await vf.handle.getFile()
    const text=await file.text()
    loading.remove()
    const wrap=document.createElement('div')
    wrap.style.cssText='padding:8px 14px;overflow:auto;flex:1;'
    wrap.innerHTML=renderCsvTable(text,vf.name)
    list.appendChild(wrap)
  }catch(e){loading.textContent='Error: '+String(e)}
}

async function traceShowFileView(s){
  const data=s.traceExplorerData
  const srv=data.servers[traceExplState.serverIdx]
  const vf=traceExplState.viewingFile
  vf._lines=[]
  vf._bookmarks=vf._bookmarks||new Set()
  vf._bookmarkCursor=null
  vf._termMatchLines=[]
  vf._termMatchCursor=null
  const bc=document.getElementById('trace-breadcrumb')
  if(bc){
    let html=`<a class="trace-crumb-link" href="#" onclick="traceNavigateUp(0);return false;">${escHtml(data.instanceDir)}</a>`
    html+=`<span class="trace-crumb-sep">/</span><a class="trace-crumb-link" href="#" onclick="traceNavigateUp(0);return false;">${escHtml(srv.name)}</a>`
    traceExplState.stack.forEach((frame,depth)=>{
      html+=`<span class="trace-crumb-sep">/</span>`
      html+=`<a class="trace-crumb-link" href="#" onclick="traceNavigateUp(${depth+1});return false;">${escHtml(frame.name)}</a>`
    })
    html+=`<span class="trace-crumb-sep">/</span>`
    html+=`<span class="trace-crumb-cur" style="user-select:text;cursor:text;" title="Click to select">${escHtml(vf.name)}</span>`
    _traceCopyPath=vf.handle?._path||vf.name
    html+=`<button onclick="traceCopyBreadcrumbPath(this)" title="Copy full path to clipboard" style="margin-left:6px;background:none;border:none;cursor:pointer;font-size:12px;padding:1px 4px;color:#A19F9D;border-radius:2px;line-height:1;" onmouseenter="this.style.color='#323130'" onmouseleave="this.style.color='#A19F9D'">📋</button>`
    bc.innerHTML=html
  }
  const list=document.getElementById('trace-list')
  if(!list)return
  list.innerHTML=''
  const up=document.createElement('div')
  up.className='trace-entry'
  up.innerHTML=`<span class="trace-icon">⬆️</span><span class="trace-name">..</span>`
  up.onclick=()=>traceCloseFile()
  list.appendChild(up)
  // Toolbar: Filter button + bookmark navigation
  const btnStyle='padding:2px 10px;font-size:11px;font-family:inherit;border-radius:2px;cursor:pointer;'
  const toolbar=document.createElement('div')
  toolbar.style.cssText='padding:4px 14px;background:#F3F2F1;border-bottom:1px solid #EDEBE9;display:flex;align-items:center;gap:6px;flex-shrink:0;position:sticky;top:0;z-index:5;'
  const filterBtn=document.createElement('button')
  filterBtn.id='trace-filter-btn'
  filterBtn.style.cssText=btnStyle+'background:#fff;color:#323130;border:1px solid #C8C6C4;'
  filterBtn.textContent='🔍 Filter ▾'
  filterBtn.addEventListener('click',()=>{
    const panel=document.getElementById('trace-filter-panel')
    if(!panel)return
    const open=panel.style.display==='flex'
    panel.style.display=open?'none':'flex'
    filterBtn.textContent=open?'🔍 Filter ▾':'🔍 Filter ▴'
  })
  const navUp=document.createElement('button')
  navUp.id='trace-nav-up'
  navUp.style.cssText=btnStyle+'background:#fff;color:#323130;border:1px solid #C8C6C4;display:none;'
  navUp.title='Previous mark'
  navUp.textContent='▲'
  navUp.addEventListener('click',()=>traceBookmarkNav(-1))
  const navDown=document.createElement('button')
  navDown.id='trace-nav-down'
  navDown.style.cssText=btnStyle+'background:#fff;color:#323130;border:1px solid #C8C6C4;display:none;'
  navDown.title='Next mark'
  navDown.textContent='▼'
  navDown.addEventListener('click',()=>traceBookmarkNav(1))
  const infoSpan=document.createElement('span')
  infoSpan.id='trace-filter-info'
  infoSpan.style.cssText='font-size:11px;color:#605E5C;margin-left:4px;'
  toolbar.appendChild(filterBtn)
  toolbar.appendChild(navUp)
  toolbar.appendChild(navDown)
  toolbar.appendChild(infoSpan)
  const loadRestBtn=document.createElement('button')
  loadRestBtn.id='trace-load-more-btn'
  loadRestBtn.style.cssText=btnStyle+'background:#EFF6FC;color:#0078D4;border:1px solid #0078D4;margin-left:auto;display:none;white-space:nowrap;'
  toolbar.appendChild(loadRestBtn)
  list.appendChild(toolbar)
  // Filter panel (hidden by default)
  const inpStyle='font-size:11px;padding:2px 5px;border:1px solid #C8C6C4;border-radius:2px;font-family:inherit;width:220px;'
  const filterPanel=document.createElement('div')
  filterPanel.id='trace-filter-panel'
  filterPanel.style.cssText='display:none;flex-direction:column;gap:5px;padding:7px 14px;background:#FAF9F8;border-bottom:1px solid #EDEBE9;flex-shrink:0;position:sticky;top:31px;z-index:4;'
  filterPanel.innerHTML=
    `<div style="display:flex;align-items:center;gap:6px;flex-wrap:wrap;">`+
    `<span style="font-size:11px;color:#605E5C;min-width:34px;">From</span>`+
    `<input type="text" id="trace-filter-from" placeholder="YYYY-MM-DD HH:MM:SS" style="${inpStyle}">`+
    `<span style="font-size:11px;color:#605E5C;">To</span>`+
    `<input type="text" id="trace-filter-to" placeholder="YYYY-MM-DD HH:MM:SS" style="${inpStyle}">`+
    `<span id="trace-filter-date-hint" style="font-size:10px;color:#A19F9D;font-style:italic;margin-left:6px;"></span>`+
    `</div>`+
    `<div style="display:flex;align-items:center;gap:6px;flex-wrap:wrap;">`+
    `<span style="font-size:11px;color:#605E5C;min-width:34px;">Terms</span>`+
    `<input type="text" id="trace-filter-terms" placeholder="term, term[[#BG]], term[[#BG,#FG]] — e.g.: savepoint[[#9600FF,#fff]], error[[#FF4444,#fff]]" style="${inpStyle.replace('width:220px','flex:1;min-width:220px')}">`+
    `<select id="trace-filter-preset" style="font-size:11px;padding:2px 4px;border:1px solid #C8C6C4;border-radius:2px;font-family:inherit;color:#605E5C;background:#fff;cursor:pointer;" title="Load preset filter"><option value="">📂 preset</option></select>`+
    `<button id="trace-filter-apply-btn" style="${btnStyle}background:#0078D4;color:#fff;border:none;">Apply</button>`+
    `<button id="trace-filter-clear-btn" style="${btnStyle}background:#fff;color:#323130;border:1px solid #C8C6C4;">Clear</button>`+
    `<label style="font-size:11px;color:#605E5C;display:flex;align-items:center;gap:4px;cursor:pointer;margin-left:6px;"><input type="checkbox" id="trace-filter-only-matches" style="cursor:pointer;margin:0;"> Show only matching lines</label>`+
    `</div>`+
    `<div style="font-size:10px;color:#605E5C;padding:1px 0 0 40px;">Color syntax: <code style="font-size:10px;">term[[#BG]]</code> or <code style="font-size:10px;">term[[#BG,#FG]]</code> — no color = grey background. Look up hex codes at <a href="https://www.color-hex.com/" target="_blank" style="color:#0078D4;text-decoration:none;">color-hex.com</a></div>`
  list.appendChild(filterPanel)
  // Restore filter state if this file had active filters
  if(vf._filterFrom||vf._filterTo||vf._searchTerms?.length||vf._termFilterOnly){
    const fi=document.getElementById('trace-filter-from')
    const ti=document.getElementById('trace-filter-to')
    const tr=document.getElementById('trace-filter-terms')
    const cb=document.getElementById('trace-filter-only-matches')
    if(fi&&vf._filterFrom)fi.value=vf._filterFrom
    if(ti&&vf._filterTo)ti.value=vf._filterTo
    if(tr&&vf._searchTerms?.length)tr.value=traceSerializeTerms(vf._searchTerms)
    if(cb)cb.checked=!!vf._termFilterOnly
    // Re-open filter panel and mark button as active so the user can see / change the filter
    filterPanel.style.display='flex'
    filterBtn.textContent='🔍 Filter ▴'
    filterBtn.style.background='#0078D4'
    filterBtn.style.color='#fff'
    filterBtn.style.border='none'
  }
  document.getElementById('trace-filter-apply-btn').addEventListener('click',traceApplyFilter)
  document.getElementById('trace-filter-clear-btn').addEventListener('click',traceClearFilter)
  // Load preset filter files from filter_pre-defined and filter_custom folders
  const presetSel=document.getElementById('trace-filter-preset')
  if(presetSel&&window.__TAURI__?.core?.invoke){
    const loadPresets=sel=>{
      window.__TAURI__.core.invoke('read_filter_files').then(presets=>{
        while(sel.children.length>1)sel.removeChild(sel.lastChild)
        if(!presets?.length)return
        const groups={}
        for(const p of presets){
          const g=p.source==='filter_pre-defined'?'Pre-defined':'Custom'
          if(!groups[g])groups[g]=[]
          groups[g].push(p)
        }
        for(const[label,items]of Object.entries(groups)){
          const grp=document.createElement('optgroup')
          grp.label=label
          for(const p of items){
            const opt=document.createElement('option')
            opt.value=p.content
            opt.textContent=p.name
            grp.appendChild(opt)
          }
          sel.appendChild(grp)
        }
      }).catch(()=>{})
    }
    loadPresets(presetSel)
    presetSel.addEventListener('focus',()=>loadPresets(presetSel))
    presetSel.addEventListener('change',()=>{
      if(!presetSel.value)return
      const ti=document.getElementById('trace-filter-terms')
      if(ti)ti.value=presetSel.value
      presetSel.value=''
      traceApplyFilter()
    })
  }
  try{
    const file=await vf.handle.getFile()
    vf.fileSize=file.size
    const MAX=50*1024*1024
    const end=Math.min(MAX,file.size)
    const text=await file.slice(0,end).text()
    vf.offset=end
    const MAX_LINE=5000
    let rawLines=text.split('\n')
    traceExplState._partialLine=end<file.size?(rawLines.pop()||''):''
    const safeLines=rawLines.map(l=>l.length>MAX_LINE?l.slice(0,MAX_LINE)+' … [line truncated]':l)
    let truncatedCount=rawLines.filter((l,i)=>safeLines[i]!==l).length
    vf._lines=safeLines
    // Auto-suggest date filter from first/last timestamp (only on fresh open, not on restore)
    if(!vf._filterFrom&&!vf._filterTo){
      let firstTs=null
      for(const line of vf._lines){
        const ts=traceExtractTimestamp(line)
        if(ts){firstTs=ts;break}
      }
      if(firstTs){
        const fi=document.getElementById('trace-filter-from')
        const ti=document.getElementById('trace-filter-to')
        const hint=document.getElementById('trace-filter-date-hint')
        if(fi)fi.value=firstTs.replace('T',' ')
        let lastTs=null
        if(end>=file.size){
          for(let i=vf._lines.length-1;i>=0;i--){
            const ts=traceExtractTimestamp(vf._lines[i])
            if(ts){lastTs=ts;break}
          }
        }else{
          try{
            const tailText=await file.slice(Math.max(0,file.size-2048),file.size).text()
            const tailLines=tailText.split('\n')
            for(let i=tailLines.length-1;i>=0;i--){
              const ts=traceExtractTimestamp(tailLines[i])
              if(ts){lastTs=ts;break}
            }
          }catch(e){}
        }
        if(lastTs){
          if(ti)ti.value=lastTs.replace('T',' ')
          if(hint)hint.textContent='start · end of trace · both editable'
        }else{
          if(ti)ti.value=traceTimePlusMins(firstTs,30)
          if(hint)hint.textContent='start of trace · To = From + 30 min · both editable'
        }
      }
    }
    traceRenderFromLines(list,vf)
    if(truncatedCount){
      const warn=document.createElement('div')
      warn.style.cssText='margin:4px 14px;padding:4px 10px;background:#FFFBE6;border:1px solid #FFE58F;border-radius:2px;font-size:11px;color:#AD6800;'
      warn.textContent=`⚠ ${truncatedCount} line(s) truncated to ${MAX_LINE} characters`
      list.insertBefore(warn,document.getElementById('trace-file-wrap'))
    }
    if(traceExplState._pendingScrollRestore!=null){
      const sv=traceExplState._pendingScrollRestore
      traceExplState._pendingScrollRestore=null
      requestAnimationFrame(()=>{list.scrollTop=sv})
    }
  }catch(e){
    list.innerHTML+=`<div style="padding:16px;color:#A19F9D;font-size:12px;">Cannot read file: ${escHtml(String(e))}</div>`
  }
}

async function traceLoadAllRemaining(){
  const vf=traceExplState?.viewingFile;if(!vf)return
  const btn=document.getElementById('trace-load-more-btn')
  const MAX_LINE=5000
  try{
    const file=await vf.handle.getFile()
    const MAX=50*1024*1024
    while(vf.offset<file.size){
      const end=Math.min(vf.offset+MAX,file.size)
      if(btn)btn.textContent=`Loading… ${formatBytes(end)} / ${formatBytes(file.size)}`
      const text=await file.slice(vf.offset,end).text()
      vf.offset=end
      const combined=(traceExplState._partialLine||'')+text
      traceExplState._partialLine=''
      let rawLines=combined.split('\n')
      if(end<file.size){traceExplState._partialLine=rawLines.pop()||''}
      const safeLines=rawLines.map(l=>l.length>MAX_LINE?l.slice(0,MAX_LINE)+' … [line truncated]':l)
      vf._lines=vf._lines.concat(safeLines)
    }
    const list=document.getElementById('trace-list')
    if(list)traceRenderFromLines(list,vf)
  }catch(e){
    if(btn){btn.disabled=false;btn.textContent='⚠️ Load failed — click to retry';btn.style.color='#CF1322';btn.style.borderColor='#CF1322';btn.onclick=async()=>{btn.disabled=true;await traceLoadAllRemaining()}}
    const info=document.getElementById('trace-filter-info')
    if(info)info.textContent='Load error: '+String(e?.message||e)
  }
}

const _TRACE_CHUNK=500
const _TRACE_LH=15
function traceCreateChunk(lines,startIdx,showNums,opts){
  const searchTerms=opts?.searchTerms||[]
  const bookmarks=opts?.bookmarks||null
  const onBMToggle=opts?.onBookmarkToggle||null
  const cv=document.createElement('div')
  cv.style.cssText=`content-visibility:auto;contain-intrinsic-block-size:${lines.length*_TRACE_LH}px;display:flex;min-width:100%;`
  if(showNums){
    const numsWrap=document.createElement('div')
    numsWrap.className='trace-nums'
    numsWrap.style.cssText=`flex-shrink:0;min-width:3.5em;background:#F3F2F1;border-right:1px solid #EDEBE9;user-select:none;-webkit-user-select:none;overflow:hidden;font-family:Consolas,monospace;font-size:11px;${onBMToggle?'cursor:pointer;':''}`
    const parts=[]
    for(let i=0;i<lines.length;i++){
      const abs=startIdx+i
      const marked=bookmarks?.has(abs)
      parts.push(`<div data-li="${abs}" style="height:${_TRACE_LH}px;line-height:${_TRACE_LH}px;text-align:right;padding:0 8px 0 4px;${marked?'background:#0078D4;color:#fff;':'color:#A19F9D;'}">${abs+1}</div>`)
    }
    numsWrap.innerHTML=parts.join('')
    if(onBMToggle)numsWrap.addEventListener('click',e=>{const d=e.target.closest('[data-li]');if(d)onBMToggle(parseInt(d.dataset.li))})
    cv.appendChild(numsWrap)
  }
  const pre=document.createElement('pre')
  pre.style.cssText=`flex:1;min-width:max-content;margin:0;padding:0 10px;font-family:Consolas,monospace;font-size:11px;line-height:${_TRACE_LH}px;white-space:pre;color:#000;`
  if(searchTerms.length){
    pre.innerHTML=lines.map(line=>{
      let s=escHtml(line)
      for(const t of searchTerms){
        const tt=typeof t==='string'?t.trim():t.text
        const bg=typeof t==='string'?'#FFD700':t.bg
        const fgColor=typeof t==='string'?'#000':(t.fg||'#000')
        if(!tt)continue
        try{s=s.replace(new RegExp(tt.replace(/[.*+?^${}()|[\]\\]/g,'\\$&'),'gi'),m=>`<mark style="background:${bg};color:${fgColor};">${m}</mark>`)}catch(e){}
      }
      return s
    }).join('\n')
  }else{pre.textContent=lines.join('\n')}
  cv.appendChild(pre)
  cv.addEventListener('contextmenu',e=>{
    const vf=traceExplState.viewingFile
    if(!vf?._displayOrigIndices)return
    e.preventDefault()
    const rect=cv.getBoundingClientRect()
    const localIdx=Math.max(0,Math.min(lines.length-1,Math.floor((e.clientY-rect.top)/_TRACE_LH)))
    const origIdx=vf._displayOrigIndices[startIdx+localIdx]
    if(origIdx!=null)showTraceLineCtxMenu(origIdx,e.clientX,e.clientY)
  })
  return cv
}

// ── Trace date/time filter + bookmarks ───────────────────────────────────────

function traceExtractTimestamp(line){
  const m=line.match(/\b(\d{4}-\d{2}-\d{2}) (\d{2}:\d{2}:\d{2})/)
  return m?m[1]+'T'+m[2]:null
}

function traceTimePlusMins(ts,mins){
  // ts: "YYYY-MM-DDTHH:MM:SS" → returns "YYYY-MM-DD HH:MM:SS" shifted by mins
  const [datePart,timePart]=ts.split('T')
  const [y,mo,d]=datePart.split('-').map(Number)
  const [h,mi,sec]=timePart.split(':').map(Number)
  const dt=new Date(Date.UTC(y,mo-1,d,h,mi+mins,sec))
  const pad=n=>String(n).padStart(2,'0')
  return `${dt.getUTCFullYear()}-${pad(dt.getUTCMonth()+1)}-${pad(dt.getUTCDate())} ${pad(dt.getUTCHours())}:${pad(dt.getUTCMinutes())}:${pad(dt.getUTCSeconds())}`
}

function traceNormalizeFilterVal(val){
  if(!val)return null
  // Accept "YYYY-MM-DD HH:MM:SS", "YYYY-MM-DDTHH:MM:SS", "YYYY-MM-DDTHH:MM", "YYYY-MM-DD"
  let s=val.trim().replace(' ','T')
  if(/^\d{4}-\d{2}-\d{2}$/.test(s))s+='T00:00:00'
  else if(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/.test(s))s+=':00'
  else if(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/.test(s))s=s.slice(0,19)
  else return null
  return s  // "YYYY-MM-DDTHH:MM:SS" — string-sortable, same format as traceExtractTimestamp
}

function traceRenderFromLines(list,vf){
  document.getElementById('trace-file-wrap')?.remove()
  const _lmb=document.getElementById('trace-load-more-btn');if(_lmb){_lmb.style.display='none';_lmb.style.color='#0078D4';_lmb.style.borderColor='#0078D4'}
  if(vf._traceObserver){vf._traceObserver.disconnect();vf._traceObserver=null}
  vf._traceAddChunks=null
  const allLines=vf._lines||[]
  let displayLines=allLines
  let origIndices=null  // null = no filter (displayLines === allLines)
  let infoText=`${allLines.length.toLocaleString()} lines loaded`
  const from=traceNormalizeFilterVal(vf._filterFrom)
  const to=traceNormalizeFilterVal(vf._filterTo)
  if(from||to){
    let lastLineVisible=!from
    const filtered=[],idxMap=[]
    for(let i=0;i<allLines.length;i++){
      const line=allLines[i]
      const ts=traceExtractTimestamp(line)
      if(ts){const visible=(!from||ts>=from)&&(!to||ts<=to);lastLineVisible=visible}
      if(lastLineVisible){filtered.push(line);idxMap.push(i)}
    }
    displayLines=filtered;origIndices=idxMap
    infoText=`${displayLines.length.toLocaleString()} / ${allLines.length.toLocaleString()} lines`
  }
  // compute term match line indices
  const terms=vf._searchTerms||[]
  if(terms.length){
    vf._termMatchLines=[]
    for(let i=0;i<displayLines.length;i++){
      const lo=displayLines[i].toLowerCase()
      if(terms.some(t=>{const tt=(typeof t==='string'?t:t.text).trim().toLowerCase();return tt&&lo.includes(tt)}))vf._termMatchLines.push(i)
    }
  } else {
    vf._termMatchLines=[]
    vf._termMatchCursor=null
  }
  // "Show only matching lines" mode: keep only lines that matched a term
  if(vf._termFilterOnly&&terms.length&&vf._termMatchLines.length){
    const matchSet=new Set(vf._termMatchLines)
    const filtered=[],idxMap=[]
    for(let i=0;i<displayLines.length;i++){
      if(matchSet.has(i)){filtered.push(displayLines[i]);idxMap.push(origIndices?origIndices[i]:i)}
    }
    displayLines=filtered;origIndices=idxMap
    vf._termMatchLines=displayLines.map((_,i)=>i)
    infoText=`${displayLines.length.toLocaleString()} / ${allLines.length.toLocaleString()} lines`
  }
  vf._displayOrigIndices=origIndices
  // update nav buttons and info
  const navUp=document.getElementById('trace-nav-up'),navDown=document.getElementById('trace-nav-down')
  const bmCount=vf._bookmarks?.size||0
  const mCount=vf._termMatchLines?.length||0
  const showNav=bmCount>0||mCount>0
  if(navUp)navUp.style.display=showNav?'':'none'
  if(navDown)navDown.style.display=showNav?'':'none'
  let suffix=''
  if(bmCount>0)suffix=` · ${bmCount} bookmark${bmCount>1?'s':''}`
  else if(mCount>0)suffix=` · ${mCount} match${mCount!==1?'es':''}`
  const info=document.getElementById('trace-filter-info')
  if(info)info.textContent=infoText+suffix
  const showNums=true
  const wrapper=document.createElement('div')
  wrapper.id='trace-file-wrap'
  wrapper.style.cssText='display:flex;flex-direction:column;align-items:flex-start;overflow-x:auto;margin:8px 14px;padding:8px 0;background:#F8F8F7;border:1px solid #EDEBE9;border-radius:2px;'
  const opts={searchTerms:terms,bookmarks:vf._bookmarks||null,onBookmarkToggle:traceToggleBookmark}
  // Lazy rendering: chunks rendered only when they scroll into view (IntersectionObserver)
  // No-filter case: getLines() reads vf._lines at render-time so "Load More" appends work seamlessly
  const getLines=origIndices?()=>displayLines:()=>vf._lines
  const observer=new IntersectionObserver((entries)=>{
    for(const entry of entries){
      if(!entry.isIntersecting||entry.target._rendered)continue
      entry.target._rendered=true;observer.unobserve(entry.target)
      const start=parseInt(entry.target.dataset.start),count=parseInt(entry.target.dataset.count)
      entry.target.replaceWith(traceCreateChunk(getLines().slice(start,start+count),start,showNums,opts))
    }
  },{rootMargin:'1000px'})
  vf._traceObserver=observer
  function _addPlaceholders(linesArr,offset){
    for(let i=0;i<linesArr.length;i+=_TRACE_CHUNK){
      const count=Math.min(_TRACE_CHUNK,linesArr.length-i)
      const ph=document.createElement('div');ph.dataset.start=offset+i;ph.dataset.count=count
      ph.style.cssText=`height:${count*_TRACE_LH}px;display:flex;min-width:100%;`;ph._rendered=false
      observer.observe(ph);wrapper.appendChild(ph)
    }
  }
  _addPlaceholders(displayLines,0)
  vf._traceAddChunks=null
  list.appendChild(wrapper)
  if(vf.offset<vf.fileSize){
    const btn=document.getElementById('trace-load-more-btn')
    if(btn){
      btn.textContent=`📥 ${formatBytes(vf.offset)} loaded · load rest (${formatBytes(vf.fileSize-vf.offset)})`
      btn.disabled=false;btn.style.display=''
      btn.onclick=async()=>{btn.disabled=true;await traceLoadAllRemaining()}
    }
  }
}

function traceSerializeTerms(terms){
  return terms.map(t=>{
    if(typeof t==='string')return t
    if(t.bg==='#808080'&&!t.fg)return t.text
    if(t.fg)return `${t.text}[[${t.bg},${t.fg}]]`
    return `${t.text}[[${t.bg}]]`
  }).join(', ')
}
function traceParseTerms(raw){
  const terms=[]
  const parts=raw.split(',')
  let cur=''
  for(const p of parts){
    cur=cur?cur+','+p:p
    const opens=(cur.match(/\[\[/g)||[]).length
    const closes=(cur.match(/\]\]/g)||[]).length
    if(opens===closes){
      cur=cur.trim()
      if(cur){
        const m=cur.match(/^(.*?)\[\[([^\]]*)\]\]\s*$/)
        if(m){
          const colors=m[2].split(',').map(c=>c.trim())
          terms.push({text:m[1].trim(),bg:colors[0]||'#808080',fg:colors[1]||null})
        }else{
          terms.push({text:cur,bg:'#808080',fg:null})
        }
      }
      cur=''
    }
  }
  if(cur.trim())terms.push({text:cur.trim(),bg:'#808080',fg:null})
  return terms.filter(t=>t.text)
}
function traceApplyFilter(){
  const vf=traceExplState?.viewingFile
  if(!vf)return
  const newFrom=document.getElementById('trace-filter-from')?.value?.trim()||null
  const newTo=document.getElementById('trace-filter-to')?.value?.trim()||null
  const timeFilterChanged=newFrom!==vf._filterFrom||newTo!==vf._filterTo
  vf._filterFrom=newFrom
  vf._filterTo=newTo
  const termsRaw=document.getElementById('trace-filter-terms')?.value?.trim()||''
  vf._searchTerms=termsRaw?traceParseTerms(termsRaw):[]
  vf._termFilterOnly=document.getElementById('trace-filter-only-matches')?.checked||false
  const btn=document.getElementById('trace-filter-btn')
  const hasFilter=vf._filterFrom||vf._filterTo||vf._searchTerms.length||vf._termFilterOnly
  if(btn)btn.style.background=hasFilter?'#0078D4':'#fff',btn.style.color=hasFilter?'#fff':'#323130',btn.style.border=hasFilter?'none':'1px solid #C8C6C4'
  if(timeFilterChanged){
    if(vf._bookmarks)vf._bookmarks.clear()
    vf._bookmarkCursor=null
  }
  const list=document.getElementById('trace-list')
  if(list)traceRenderFromLines(list,vf)
}

function traceClearFilter(){
  const vf=traceExplState?.viewingFile
  if(!vf)return
  vf._filterFrom=null
  vf._filterTo=null
  vf._searchTerms=[]
  vf._termFilterOnly=false
  vf._termMatchLines=[]
  vf._termMatchCursor=null
  if(vf._bookmarks)vf._bookmarks.clear()
  vf._bookmarkCursor=null
  const f=document.getElementById('trace-filter-from'),t=document.getElementById('trace-filter-to'),tr=document.getElementById('trace-filter-terms')
  if(f)f.value=''
  if(t)t.value=''
  if(tr)tr.value=''
  const hint=document.getElementById('trace-filter-date-hint')
  if(hint)hint.textContent=''
  const cb=document.getElementById('trace-filter-only-matches')
  if(cb)cb.checked=false
  const btn=document.getElementById('trace-filter-btn')
  if(btn)btn.style.background='#fff',btn.style.color='#323130',btn.style.border='1px solid #C8C6C4'
  const list=document.getElementById('trace-list')
  if(list)traceRenderFromLines(list,vf)
}

function traceToggleBookmark(absIdx){
  const vf=traceExplState?.viewingFile
  if(!vf||!vf._bookmarks)return
  if(vf._bookmarks.has(absIdx)){vf._bookmarks.delete(absIdx)}else{vf._bookmarks.add(absIdx)}
  const d=document.querySelector(`[data-li="${absIdx}"]`)
  if(d){
    const marked=vf._bookmarks.has(absIdx)
    d.style.background=marked?'#0078D4':''
    d.style.color=marked?'#fff':'#A19F9D'
  }
  const bmCount=vf._bookmarks.size
  const mCount=vf._termMatchLines?.length||0
  const navUp=document.getElementById('trace-nav-up'),navDown=document.getElementById('trace-nav-down')
  const showNav=bmCount>0||mCount>0
  if(navUp)navUp.style.display=showNav?'':'none'
  if(navDown)navDown.style.display=showNav?'':'none'
  const info=document.getElementById('trace-filter-info')
  if(info){
    const base=info.textContent.replace(/ · \d+ bookmark[s]?| · \d+ match(?:es)?/g,'')
    let suffix=''
    if(bmCount>0)suffix=` · ${bmCount} bookmark${bmCount>1?'s':''}`
    else if(mCount>0)suffix=` · ${mCount} match${mCount!==1?'es':''}`
    info.textContent=base+suffix
  }
  if(!vf._bookmarks.has(absIdx)&&vf._bookmarkCursor===absIdx)vf._bookmarkCursor=null
}

function traceBookmarkNav(dir){
  const vf=traceExplState?.viewingFile
  if(!vf)return
  const bmSize=vf._bookmarks?.size||0
  const matchLines=vf._termMatchLines||[]
  if(bmSize>0){
    const sorted=[...vf._bookmarks].sort((a,b)=>a-b)
    let idx
    if(vf._bookmarkCursor==null){idx=dir>0?0:sorted.length-1}
    else{const cur=sorted.indexOf(vf._bookmarkCursor);idx=cur<0?(dir>0?0:sorted.length-1):((cur+dir+sorted.length)%sorted.length)}
    vf._bookmarkCursor=sorted[idx]
    traceScrollToLine(vf._bookmarkCursor)
  } else if(matchLines.length>0){
    let idx
    if(vf._termMatchCursor==null){idx=dir>0?0:matchLines.length-1}
    else{const cur=matchLines.indexOf(vf._termMatchCursor);idx=cur<0?(dir>0?0:matchLines.length-1):((cur+dir+matchLines.length)%matchLines.length)}
    vf._termMatchCursor=matchLines[idx]
    traceScrollToLine(vf._termMatchCursor)
  }
}

function traceScrollToLine(absIdx){
  const list=document.getElementById('trace-list')
  const wrap=document.getElementById('trace-file-wrap')
  if(!list||!wrap)return
  // try to find the exact div first for precise positioning
  const d=document.querySelector(`[data-li="${absIdx}"]`)
  if(d){
    const top=d.getBoundingClientRect().top-list.getBoundingClientRect().top+list.scrollTop
    list.scrollTo({top:top-list.clientHeight/2,behavior:'smooth'})
    // flash outline
    d.style.outline='2px solid #FFD700'
    setTimeout(()=>{d.style.outline=''},800)
  } else {
    // fallback: estimate via line height
    list.scrollTo({top:wrap.offsetTop+absIdx*_TRACE_LH-list.clientHeight/2,behavior:'smooth'})
  }
}


async function scanConfigDir(s){
  const configDir=s.configDirHandle
  if(!configDir)return
  s.configFileHandles=[]
  const _subdirNames=[],_subdirSet=new Set(),_direct=new Set()
  try{for await(const[n,h]of configDir.entries()){if(h.kind==='file'&&n.endsWith('.ini')){s.configFileHandles.push({name:n,handle:h});_direct.add(n)}else if(h.kind==='directory'){_subdirNames.push(n);_subdirSet.add(n)}}}catch(e){}
  for(const fn of HANA_INI_FILES){if(!_direct.has(fn)){try{const fh=await configDir.getFileHandle(fn);s.configFileHandles.push({name:fn,handle:fh})}catch(e){}}}
  if(!_subdirSet.has('SYSTEMDB'))_subdirNames.push('SYSTEMDB')
  const _sm=s.label.match(/^(?:fullsysteminfodump_)?([A-Z][A-Z0-9]{1,})_/i)||s.label.match(/^([A-Z][A-Z0-9]{1,2})$/i)
  if(_sm){const sid=_sm[1].toUpperCase();if(sid!=='SYSTEMDB'){const g='DB_'+sid;if(!_subdirSet.has(g))_subdirNames.push(g)}}
  for(const sub of _subdirNames){
    try{
      const subH=await configDir.getDirectoryHandle(sub),sf=new Set()
      try{for await(const[fn,fh]of subH.entries()){if(fh.kind==='file'&&fn.endsWith('.ini')){s.configFileHandles.push({name:fn,handle:fh,tenant:sub});sf.add(fn)}}}catch(e){}
      for(const fn of HANA_INI_FILES){if(!sf.has(fn)){try{const fh=await subH.getFileHandle(fn);s.configFileHandles.push({name:fn,handle:fh,tenant:sub})}catch(e){}}}
    }catch(e){}
  }
  const _sk=new Set();s.configFileHandles=s.configFileHandles.filter(h=>{const k=(h.tenant||'')+'/'+h.name;return _sk.has(k)?false:(_sk.add(k),true)})
  s.configFileHandles.sort((a,b)=>a.name.localeCompare(b.name))
}

async function renderConfigContent(s, wrap){
  if(typeof BUNDLED_CONFIG_INI!=='undefined'&&!s._configRefLoaded){
    s.configRefData={}
    for(const [name,text] of Object.entries(BUNDLED_CONFIG_INI)){
      s.configRefData[name]=parseRefIni(text)
    }
    s._configRefLoaded=true
  } else if(Object.keys(s.configRefHandles||{}).length>0&&!s._configRefLoaded){
    s.configRefData={}
    for(const[name,handle]of Object.entries(s.configRefHandles)){
      try{const f=await handle.getFile();s.configRefData[name]=parseRefIni(await f.text())}catch(e){}
    }
    s._configRefLoaded=true
  }
  const hasRef=Object.keys(s.configRefData||{}).length>0
  const mode=s.configViewMode||'pure'
  const tenantName=s.configFileHandles[0]?.tenant
  const tenantHint=tenantName?` &nbsp;·&nbsp; <strong>${escHtml(tenantName)}</strong>`:''
  const btnStyle=(active)=>`padding:5px 14px;border:none;background:${active?'#0078D4':'#fff'};color:${active?'#fff':'#323130'};cursor:pointer;font-family:inherit;font-size:12px;`
  const parts=[]
  parts.push(`<div style="margin-bottom:14px;display:flex;align-items:center;gap:10px;flex-wrap:wrap;">
    <div style="display:flex;border:1px solid #EDEBE9;border-radius:2px;overflow:hidden;">
      <button onclick="configToggleView('explained')" style="${btnStyle(mode==='explained')}">Explained</button>
      <button onclick="configToggleView('pure')" style="${btnStyle(mode==='pure')}border-left:1px solid #EDEBE9;">Pure</button>
    </div>
    ${mode==='explained'&&hasRef?`<span style="font-size:12px;color:#605E5C;">📚 <a href="https://help.sap.com/docs/SAP_HANA_PLATFORM/009e68bc5f3c440cb31823a3ec4bb95b/4b4d88980622427ab2d6ca8c05448166.html?locale=en-US" target="_blank" style="color:#0078D4;text-decoration:underline;">SAP HANA Parameter Reference</a>${tenantHint}</span>`:''}
  </div>`)
  if(mode==='explained'){
    if(!hasRef){
      parts.push(`<div style="margin:24px 0;padding:20px;background:#F3F2F1;border:1px solid #EDEBE9;border-radius:4px;text-align:center;">
        <div style="color:#605E5C;font-size:13px;margin-bottom:12px;">No reference data available. Select a reference folder to enable the Explained view.</div>
        <button onclick="configPickRefFolder()" style="padding:7px 16px;background:#0078D4;color:#fff;border:none;border-radius:2px;cursor:pointer;font-family:inherit;font-size:13px;">📁 Load reference folder…</button>
      </div>`)
    } else {
      for(const{name,handle,content}of s.configFileHandles){
        try{const text=content!==undefined?content:(await (await handle.getFile()).text());parts.push(renderIniFile(name,text))}catch(e){}
      }
    }
  } else {
    for(const{name,handle,content}of s.configFileHandles){
      try{
        const text=content!==undefined?content:(await (await handle.getFile()).text())
        parts.push(`<div class="card" style="margin-bottom:18px;"><div class="card-title">📄 ${escHtml(name)}</div><div class="card-body" style="padding:0;overflow-x:auto;"><pre style="margin:0;padding:10px 12px;font-family:Consolas,monospace;font-size:11px;line-height:1.4;white-space:pre;color:#323130;">${escHtml(text)}</pre></div></div>`)
      }catch(e){}
    }
  }
  wrap.innerHTML=parts.join('')
}

async function configToggleView(mode){
  const s=activeSess()
  if(!s) return
  s.configViewMode=mode
  const wrap=document.querySelector('#panel-configuration > div')
  if(!wrap) return
  wrap.innerHTML='<div style="color:#A19F9D;font-size:12px;">Loading…</div>'
  await renderConfigContent(s,wrap)
}

async function hsiConfigToggleView(mode,sid,tabId,dbName){
  const s=sess(sid)
  if(!s) return
  s.configViewMode=mode
  await activateHsiTab(sid,tabId,dbName)
}

async function configPickRefFolder(){
  const s=activeSess()
  if(!s) return
  let dirHandle
  try{
    dirHandle=await window.showDirectoryPicker({mode:'read',id:'config-ref',...(_lastPickedHandle?{startIn:_lastPickedHandle}:{})})
  }catch(e){ if(e.name!=='AbortError') console.error(e); return }
  _lastPickedHandle=dirHandle
  s.configRefHandles={}
  for await(const [name,handle] of dirHandle.entries()){
    if(handle.kind==='file'&&name.endsWith('.ini')) s.configRefHandles[name]=handle
  }
  s._configRefLoaded=false
  s.configViewMode='explained'
  const wrap=document.querySelector('#panel-configuration > div')
  if(!wrap) return
  wrap.innerHTML='<div style="color:#A19F9D;font-size:12px;">Loading…</div>'
  await renderConfigContent(s,wrap)
}

async function hsiConfigPickRefFolder(sid,tabId,dbName){
  const s=sess(sid);if(!s||!s.hsiConfigData)return
  let dirHandle
  try{
    dirHandle=await window.showDirectoryPicker({mode:'read',id:'hsi-config-ref',...(_lastPickedHandle?{startIn:_lastPickedHandle}:{})})
  }catch(e){if(e.name!=='AbortError')console.error(e);return}
  _lastPickedHandle=dirHandle
  const refs={}
  try{for await(const[n,h]of dirHandle.entries()){if(h.kind==='file'&&n.endsWith('.ini'))refs[n]=h}}catch(e){}
  s.hsiConfigData.refHandles=refs
  s.hsiConfigData.parsedRef=null
  if(!s.configViewMode)s.configViewMode='explained'
  await activateHsiTab(sid,tabId,dbName)
}

async function configPickFolder(){
  const s=activeSess()
  if(!s) return
  let dirHandle
  try{
    dirHandle=await window.showDirectoryPicker({mode:'read',id:'config-folder',...(s.configDirHandle?{startIn:s.configDirHandle}:(_lastPickedHandle?{startIn:_lastPickedHandle}:{}))})
  }catch(e){ if(e.name!=='AbortError') console.error(e); return }
  _lastPickedHandle=dirHandle
  // Replace configDirHandle with the fresh user-picked handle and re-scan
  s.configDirHandle=dirHandle
  s.configFileHandles=[]
  s._configScanned=false
  const wrap=document.querySelector('#panel-configuration > div')
  if(!wrap) return
  wrap.innerHTML='<div style="color:#A19F9D;font-size:12px;">Loading…</div>'
  await scanConfigDir(s)
  s._configScanned=true
  if(!s.configFileHandles.length){
    wrap.innerHTML='<div class="not-found-msg"><span class="nf-icon">⚠️</span><span>No <strong>.ini files</strong> found in the selected folder.</span></div>'
    return
  }
  if(!s.configViewMode) s.configViewMode='explained'
  await renderConfigContent(s,wrap)
}

async function hsiPermUpload(btn){
  let fh
  try{
    ;[fh]=await window.showOpenFilePicker({
      id:'hsi-ref-file',
      types:[{description:'Log file',accept:{'text/plain':['.log','.txt']}}],
      multiple:false,
      ...(_lastPickedHandle?{startIn:_lastPickedHandle}:{})
    })
    _lastPickedHandle=fh
  }catch(e){if(e.name!=='AbortError')alert('Error: '+e.message);return}
  try{
    const f=await fh.getFile()
    const text=await f.text()
    const container=btn.closest('.hsi-content-area')
    if(!container)return

    const refSections=parsePermSections(text)
    const refMap=new Map(refSections.map(s=>[s.path,s]))
    const refVer=_extractPermVersionLine(text)
    const badge=container.querySelector('.hsi-ref-version-badge')
    if(badge) badge.innerHTML=refVer?`<div style="font-size:10px;color:#605E5C;font-weight:400;margin-top:3px;font-family:Consolas,monospace;">${escHtml(refVer)}</div>`:''

    // Fill existing captured sections
    const refCols=container.querySelectorAll('.hsi-ref-section[data-ref-path]')
    const capturedPaths=new Set()
    refCols.forEach(col=>{
      const path=col.getAttribute('data-ref-path')
      capturedPaths.add(path)
      col.innerHTML=refMap.has(path)
        ?renderPermContentLines(refMap.get(path).lines)
        :'<div class="hsi-perm-ref-empty" style="color:#A19F9D;">Path not in reference file</div>'
    })

    // Add sections only in reference (not in captured)
    const TOP_BTN=`<a href="#hsi-top" style="font-size:0.76em;text-decoration:none;color:#6c757d;padding:2px 8px;border:1px solid #dee2e6;border-radius:12px;white-space:nowrap;flex-shrink:0;" title="Top">▲ TOP</a>`
    for(const sec of refSections){
      if(capturedPaths.has(sec.path))continue
      const wrap=document.createElement('div')
      wrap.innerHTML=`<div class="hsi-h4">${TOP_BTN} ls -lah ${escHtml(sec.path)} <span style="font-size:0.75em;background:#fff3cd;color:#856404;padding:1px 7px;border-radius:4px;margin-left:6px;">Reference only</span></div>
        <div class="hsi-perm-split">
          <div class="hsi-perm-col"><div class="hsi-log-block"><div class="hsi-perm-ref-empty" style="color:#A19F9D;">Not in captured data</div></div></div>
          <div class="hsi-perm-col"><div class="hsi-log-block">${renderPermContentLines(sec.lines)}</div></div>
        </div>`
      container.appendChild(wrap)
    }

    btn.textContent='📄 '+f.name
    btn.style.background='#198754'
  }catch(e){alert('Error loading file: '+e.message)}
}

function renderAvailability(text,hostName,filename){
  const lines=text.split('\n').map(l=>l.replace(/\r$/,'')).filter(l=>l.trim())
  if(lines.length<2)return '<div class="not-found-msg"><span class="nf-icon">⚠️</span><span>File is empty or has no data.</span></div>'
  const headers=lines[0].split(';')
  const rows=lines.slice(1).map(l=>l.split(';'))
  const COL={}
  headers.forEach((h,i)=>COL[h.trim()]=i)
  const STATUS_COLS=new Set(['system_status','host_status'])
  const ACTIVE_COLS=new Set(['system_active','host_active','service_active','database_active','is_origin'])
  function statusTag(val){
    const v=(val||'').toLowerCase()
    if(v==='ok') return tag('tag-green',val)
    if(v==='warning') return tag('tag-warn',val)
    if(v==='error') return tag('tag-red',val)
    if(v==='unknown') return tag('tag-orange',val)
    if(v==='') return ''
    return `<span class="mono">${escHtml(val)}</span>`
  }
  function activeTag(val){
    const v=(val||'').toLowerCase()
    if(v==='true'||v==='1') return tag('tag-green',val)
    if(v==='false'||v==='0') return `<span class="mono" style="color:#A19F9D;">${escHtml(val)}</span>`
    if(v==='') return ''
    return `<span class="mono">${escHtml(val)}</span>`
  }
  function eventTag(val){
    const v=(val||'').toLowerCase()
    if(v==='ping') return `<span class="mono" style="color:#A19F9D;">${escHtml(val)}</span>`
    if(v.includes('start')) return tag('tag-green',val)
    if(v.includes('stop')) return tag('tag-orange',val)
    if(v.includes('error')||v.includes('fail')||v.includes('crash')) return tag('tag-red',val)
    if(v==='') return ''
    return tag('tag-blue',val)
  }
  const tbodyId='avail-body-'+hostName.replace(/[^a-z0-9]/gi,'-')
  const hideCount=rows.filter(r=>(r[COL['event_name']]||'').toLowerCase()==='ping'&&(r[COL['system_status']]||'').toLowerCase()==='ok'&&(r[COL['host_status']]||'').toLowerCase()==='ok').length
  let html=`<div class="card"><div class="card-title" style="display:flex;align-items:center;gap:10px;flex-wrap:wrap;">🟢 System Availability <span style="font-weight:400;font-size:11px;color:#605E5C;">${escHtml(hostName)} &nbsp;|&nbsp; ${rows.length} rows &nbsp;|&nbsp; ${escHtml(filename)}</span>
  <button id="${tbodyId}-btn" onclick="toggleAvailOk('${tbodyId}')" style="margin-left:auto;padding:2px 10px;border:1px solid #EDEBE9;border-radius:2px;background:#F3F2F1;font-family:inherit;font-size:11px;cursor:pointer;">🙈 Hide ping/ok rows (${hideCount})</button>
  </div>
  <div style="overflow-x:auto;max-height:calc(100vh - 160px);overflow-y:auto;">
  <table class="data-table" style="white-space:nowrap;width:auto;min-width:100%;">
  <thead style="position:sticky;top:0;z-index:5;"><tr>`
  for(const h of headers) html+=`<th>${escHtml(h)}</th>`
  html+=`</tr></thead><tbody id="${tbodyId}">`
  for(const row of rows){
    const evtName=(row[COL['event_name']]||'').toLowerCase()
    const sysStatus=(row[COL['system_status']]||'').toLowerCase()
    const hostStatus=(row[COL['host_status']]||'').toLowerCase()
    const isPing=evtName==='ping'
    const isHideable=isPing&&sysStatus==='ok'&&hostStatus==='ok'
    html+=`<tr${isHideable?' data-hideable="1"':''}${isPing?' style="opacity:0.45;"':''}>`
    for(let i=0;i<headers.length;i++){
      const colName=headers[i].trim()
      const val=row[i]??''
      let cell
      if(STATUS_COLS.has(colName)) cell=statusTag(val)
      else if(ACTIVE_COLS.has(colName)) cell=activeTag(val)
      else if(colName==='event_name') cell=eventTag(val)
      else if(colName==='error_message'&&val) cell=`<span class="mono" style="color:#CF1322;">${escHtml(val)}</span>`
      else cell=val?`<span class="mono">${escHtml(val)}</span>`:''
      html+=`<td>${cell}</td>`
    }
    html+=`</tr>`
  }
  html+=`</tbody></table></div></div>`
  return html
}

function toggleAvailOk(tbodyId){
  const tbody=document.getElementById(tbodyId)
  const btn=document.getElementById(tbodyId+'-btn')
  if(!tbody||!btn) return
  const hiding=btn.dataset.hiding!=='1'
  btn.dataset.hiding=hiding?'1':''
  const hideCount=tbody.querySelectorAll('tr[data-hideable="1"]').length
  btn.textContent=hiding?`👁 Show ping/ok rows (${hideCount})`:`🙈 Hide ping/ok rows (${hideCount})`
  tbody.querySelectorAll('tr[data-hideable="1"]').forEach(tr=>{tr.style.display=hiding?'none':''})
}


// ══════════════════════════════════════════════════════════════════════════
// Nameserver History — Chart.js viewer
// ══════════════════════════════════════════════════════════════════════════

const _NSC_PALETTE=['#0078D4','#107C10','#D83B01','#8764B8','#038387','#D47500','#A4262C','#B146C2','#00B7C3','#004E8C','#881798','#69797E','#01B8AA','#E81123','#0099BC']
const _NSC_DEFAULT=new Set(['cpuUsed','indexserverMemUsed','mvccNum'])
const _nsChartState={}

// Hardcoded metric → display group (10 groups matching reference tool)
const _NSC_GROUPS={
  'cpuUsed':'Host','memoryResident':'Host','memoryTotalResident':'Host','memoryUsed':'Host','memoryLimit':'Host','memorySize':'Host','diskUsed':'Host','diskSize':'Host','networkIn':'Host','networkOut':'Host','swapIn':'Host','swapOut':'Host',
  'indexserverCpu':'Service','indexserverCpuSys':'Service','indexserverMemUsed':'Service','indexserverMemLimit':'Service','indexserverHandles':'Service','indexserverPingtime':'Service','indexserverSwapIn':'Service',
  'sqlConnections':'SQL','internalConnections':'SQL','externalConnections':'SQL','idleConnections':'SQL','sqlTransactions':'SQL','internalTransactions':'SQL','externalTransactions':'SQL','userTransactions':'SQL','sqlBlockedTrans':'SQL','sqlStatements':'SQL','cidRange':'SQL','tidRange':'SQL','pendingRequestCount':'SQL',
  'mvccNum':'Row Store','acquiredRecordLocks':'Row Store',
  'searchCount':'Column Store','indexingCount':'Column Store','mergeCount':'Column Store','unloadCount':'Column Store',
  'indexserverThreads':'Threads','waitingThreads':'Threads','totalThreads':'Threads','activeSqlExecutors':'Threads','waitingSqlExecutors':'Threads','totalSqlExecutors':'Threads',
  'dataWriteSize':'Persistence','dataWriteTime':'Persistence','logWriteSize':'Persistence','logWriteTime':'Persistence','dataReadSize':'Persistence','dataReadTime':'Persistence','logReadSize':'Persistence','logReadTime':'Persistence',
  'dataBackupWriteSize':'Backup','dataBackupWriteTime':'Backup','logBackupWriteSize':'Backup','logBackupWriteTime':'Backup',
  'mutexCollisionCount':'Synchronization Primitives','readWriteLockCollisionCount':'Synchronization Primitives',
  'admissinControlAdmitCount':'Session Admission Control','admissionControlRejectCount':'Session Admission Control','admissionControlWaitingRequests':'Session Admission Control','admissionControlWaitTime':'Session Admission Control','admissionControlEnqueueCount':'Session Admission Control','admissionControlDequeueCount':'Session Admission Control','admissionControlTimeoutCount':'Session Admission Control',
}
// Metric → scale group (same-group metrics share Y-Scale; 'unknown' = individual)
const _NSC_SGROUPS={
  'cpuUsed':'pct','indexserverCpu':'pct','indexserverCpuSys':'pct',
  'memoryResident':'memory','memoryTotalResident':'memory','memoryUsed':'memory','memoryLimit':'memory','memorySize':'memory','indexserverMemUsed':'memory','indexserverMemLimit':'memory',
  'diskUsed':'disk','diskSize':'disk',
  'networkIn':'net','networkOut':'net',
  'swapIn':'swap','swapOut':'swap','indexserverSwapIn':'swap',
  'searchCount':'req','indexingCount':'req','mergeCount':'req','unloadCount':'req',
  'sqlStatements':'stmt',
  'dataWriteSize':'wrsize','logWriteSize':'wrsize','dataReadSize':'wrsize','logReadSize':'wrsize','dataBackupWriteSize':'wrsize','logBackupWriteSize':'wrsize',
  'dataWriteTime':'wrtime','logWriteTime':'wrtime','dataReadTime':'wrtime','logReadTime':'wrtime','dataBackupWriteTime':'wrtime','logBackupWriteTime':'wrtime',
  'sqlConnections':'conn','internalConnections':'conn','externalConnections':'conn','idleConnections':'conn',
  'sqlTransactions':'trans','internalTransactions':'trans','externalTransactions':'trans','userTransactions':'trans',
}
// Metric → unit conversion type
const _NSC_CONV={
  'memoryResident':'mb','memoryTotalResident':'mb','memoryUsed':'mb','memoryLimit':'mb','memorySize':'mb','indexserverMemUsed':'mb','indexserverMemLimit':'mb',
  'diskUsed':'gb','diskSize':'gb',
  'networkIn':'mb_rate','networkOut':'mb_rate','swapIn':'mb_rate','swapOut':'mb_rate','indexserverSwapIn':'mb_rate',
  'dataWriteSize':'mb_rate','logWriteSize':'mb_rate','dataReadSize':'mb_rate','logReadSize':'mb_rate','dataBackupWriteSize':'mb_rate','logBackupWriteSize':'mb_rate',
  'dataWriteTime':'us_rate','logWriteTime':'us_rate','dataReadTime':'us_rate','logReadTime':'us_rate','dataBackupWriteTime':'us_rate','logBackupWriteTime':'us_rate',
  'searchCount':'rate','indexingCount':'rate','mergeCount':'rate','unloadCount':'rate',
  'sqlStatements':'rate',
  'mutexCollisionCount':'rate','readWriteLockCollisionCount':'rate',
  'admissinControlAdmitCount':'rate','admissionControlRejectCount':'rate','admissionControlWaitingRequests':'rate','admissionControlWaitTime':'rate','admissionControlEnqueueCount':'rate','admissionControlDequeueCount':'rate','admissionControlTimeoutCount':'rate',
}
// Human-readable display labels for each metric (matching original ngx-hana-nameserver-history-viewer)
const _NSC_LABELS={
  'cpuUsed':'CPU Used','memoryResident':'Database Resident Memory','memoryTotalResident':'Total Resident Memory',
  'memoryUsed':'Memory Used','memoryLimit':'Memory Limit','memorySize':'Memory Size',
  'diskUsed':'Disk Used','diskSize':'Disk Size','networkIn':'Network In','networkOut':'Network Out','swapIn':'Swap In','swapOut':'Swap Out',
  'indexserverCpu':'IndexServer CPU','indexserverCpuSys':'IndexServer CPU Sys',
  'indexserverMemUsed':'IndexServer Memory Used','indexserverMemLimit':'IndexServer Memory Limit',
  'indexserverHandles':'IndexServer Handles','indexserverPingtime':'IndexServer Ping Time','indexserverSwapIn':'IndexServer Swap In',
  'sqlConnections':'SQL Connections','internalConnections':'Internal Connections','externalConnections':'External Connections',
  'idleConnections':'Idle Connections','sqlTransactions':'SQL Transactions','internalTransactions':'Internal Transactions',
  'externalTransactions':'External Transactions','userTransactions':'User Transactions',
  'sqlBlockedTrans':'SQL Blocked Transactions','sqlStatements':'SQL Statements',
  'cidRange':'CID Range','tidRange':'TID Range','pendingRequestCount':'Pending Request Count',
  'mvccNum':'MVCC Versions','acquiredRecordLocks':'Acquired Record Locks',
  'searchCount':'Search Count','indexingCount':'Indexing Count','mergeCount':'Merge Count','unloadCount':'Unload Count',
  'indexserverThreads':'IndexServer Threads','waitingThreads':'Waiting Threads','totalThreads':'Total Threads',
  'activeSqlExecutors':'Active SQL Executors','waitingSqlExecutors':'Waiting SQL Executors','totalSqlExecutors':'Total SQL Executors',
  'dataWriteSize':'Data Write Size','dataWriteTime':'Data Write Time','logWriteSize':'Log Write Size','logWriteTime':'Log Write Time',
  'dataReadSize':'Data Read Size','dataReadTime':'Data Read Time','logReadSize':'Log Read Size','logReadTime':'Log Read Time',
  'dataBackupWriteSize':'Data Backup Write Size','dataBackupWriteTime':'Data Backup Write Time',
  'logBackupWriteSize':'Log Backup Write Size','logBackupWriteTime':'Log Backup Write Time',
  'mutexCollisionCount':'Mutex Collision Count','readWriteLockCollisionCount':'ReadWrite Lock Collision Count',
  'admissinControlAdmitCount':'Admission Control Admit Count','admissionControlRejectCount':'Admission Control Reject Count',
  'admissionControlWaitingRequests':'Admission Control Waiting Requests','admissionControlWaitTime':'Admission Control Wait Time',
  'admissionControlEnqueueCount':'Admission Control Enqueue Count','admissionControlDequeueCount':'Admission Control Dequeue Count',
  'admissionControlTimeoutCount':'Admission Control Timeout Count',
}
// Apply unit conversions to parsed data (in-place):
//   mb = bytes→MB (÷1048576), gb = bytes→GB (÷1073741824)
//   rate = per-interval count÷interval_s, mb_rate = bytes÷1048576÷interval_s, us_rate = µs÷1e6÷interval_s
function _nscApplyConversions(parsed){
  const _unitAfter={mb:'MB',gb:'GB',mb_rate:'MBit/s'}
  parsed.metrics.forEach((m,mi)=>{
    const ct=_NSC_CONV[m.name];if(!ct)return
    if(_unitAfter[ct])m.unit=_unitAfter[ct]
    for(const port of parsed.ports){
      const pd=parsed.byPort[port],vals=pd.values[mi],ts=pd.timestamps
      if(ct==='mb'){
        for(let i=0;i<vals.length;i++)if(Number.isFinite(vals[i]))vals[i]/=1048576
      }else if(ct==='gb'){
        for(let i=0;i<vals.length;i++)if(Number.isFinite(vals[i]))vals[i]/=1073741824
      }else if(ct==='rate'){
        vals[0]=0
        for(let i=1;i<vals.length;i++){const dt=(ts[i]-ts[i-1])/1000;vals[i]=(dt>0&&Number.isFinite(vals[i]))?Math.max(0,vals[i]/dt):NaN}
      }else if(ct==='mb_rate'){
        vals[0]=0
        for(let i=1;i<vals.length;i++){const dt=(ts[i]-ts[i-1])/1000;vals[i]=(dt>0&&Number.isFinite(vals[i]))?Math.max(0,vals[i]/1048576/dt):NaN}
      }else if(ct==='us_rate'){
        vals[0]=0
        for(let i=1;i<vals.length;i++){const dt=(ts[i]-ts[i-1])/1000;vals[i]=(dt>0&&Number.isFinite(vals[i]))?Math.max(0,vals[i]/1e6/dt):NaN}
      }
    }
  })
}

function _nscAxisId(unit){
  if(!unit)return 'y-rate'
  if(unit.includes('%'))return 'y-pct'
  if(unit.toLowerCase().includes('byte'))return 'y-bytes'
  return 'y-rate'
}
function _nscFmtBytes(v){const a=Math.abs(v);if(a>=1e9)return(v/1e9).toFixed(1)+'G';if(a>=1e6)return(v/1e6).toFixed(1)+'M';if(a>=1e3)return(v/1e3).toFixed(1)+'K';return v.toFixed(0)}
function _nscFmtTs(ms){const d=new Date(ms),p=n=>String(n).padStart(2,'0');return`${d.getFullYear()}-${p(d.getMonth()+1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`}

function _nscLttb(ts,ys,n){
  const pts=ts.map((x,i)=>({x,y:ys[i]})).filter(p=>Number.isFinite(p.y))
  if(!pts.length)return{xs:[],ys:[]}
  const len=pts.length
  if(len<=n)return{xs:pts.map(p=>p.x),ys:pts.map(p=>p.y)}
  const outX=[pts[0].x],outY=[pts[0].y]
  const bSz=(len-2)/(n-2);let a=0
  for(let i=0;i<n-2;i++){
    const aS=Math.floor((i+1)*bSz)+1,aE=Math.min(Math.floor((i+2)*bSz)+1,len)
    let avgX=0,avgY=0;for(let j=aS;j<aE;j++){avgX+=pts[j].x;avgY+=pts[j].y}
    avgX/=(aE-aS);avgY/=(aE-aS)
    const bS=Math.floor(i*bSz)+1,bE=Math.min(Math.floor((i+1)*bSz)+1,len)
    let maxA=-1,maxI=bS
    for(let j=bS;j<bE;j++){const area=Math.abs((pts[a].x-avgX)*(pts[j].y-pts[a].y)-(pts[a].x-pts[j].x)*(avgY-pts[a].y))*0.5;if(area>maxA){maxA=area;maxI=j}}
    outX.push(pts[maxI].x);outY.push(pts[maxI].y);a=maxI
  }
  outX.push(pts[len-1].x);outY.push(pts[len-1].y)
  return{xs:outX,ys:outY}
}

function _nscCat(name){
  const n=name.toLowerCase()
  if(n.includes('cpu')||n.includes('sys'))return'cpu'
  if(n.includes('mem')||n.includes('heap')||n.includes('swap'))return'mem'
  if(n.includes('sql')||n.includes('statement')||n.includes('transaction')||n.includes('connection'))return'sql'
  if(n.includes('thread'))return'thread'
  return'other'
}

function nsChartParse(txt){
  const rawLines=txt.split('\n')
  let hi=0;while(hi<rawLines.length&&!rawLines[hi].trim())hi++
  if(hi>=rawLines.length)return null
  const rawH=rawLines[hi].split(';').map(h=>h.trim())
  const clean=rawH.map(h=>h.replace(/\s*\[.*?\]$/,'').trim())
  const units=rawH.map(h=>{const m=h.match(/\[([^\]]+)\]$/);return m?m[1]:''})
  const iHost=clean.indexOf('host'),iPort=clean.indexOf('port'),iTime=clean.indexOf('time')
  if(iHost<0||iTime<0)return null
  const mCols=clean.map((_,i)=>i).filter(i=>i!==iHost&&i!==iPort&&i!==iTime)
  const metrics=mCols.map(i=>({idx:i,name:clean[i],unit:units[i],label:rawH[i]}))
  const prev=new Float64Array(rawH.length)
  const byPort={}
  for(let ri=hi+1;ri<rawLines.length;ri++){
    const line=rawLines[ri];if(!line||!line.trim())continue
    const parts=line.split(';')
    const rawHost=(parts[iHost]||'').trim()
    const rawPort=iPort>=0?(parts[iPort]||'').trim():''
    const isHostRow=rawHost&&!/^[\d><]/.test(rawHost)
    const isServiceRow=!isHostRow&&rawPort&&/^[\d><]/.test(rawPort)
    for(let ci=0;ci<parts.length&&ci<prev.length;ci++){
      const v=(parts[ci]||'').trim();if(!v)continue
      if(v[0]==='>'){prev[ci]+=parseFloat(v.slice(1))||0}
      else if(v[0]==='<'){prev[ci]-=parseFloat(v.slice(1))||0}
      else{const n=parseFloat(v);if(!isNaN(n))prev[ci]=n}
    }
    if(isServiceRow){
      const portStr=String(Math.round(prev[iPort]))
      if(!byPort[portStr])byPort[portStr]={timestamps:[],values:mCols.map(()=>[])}
      byPort[portStr].timestamps.push(prev[iTime]*1000)
      mCols.forEach((ci,mi)=>byPort[portStr].values[mi].push(prev[ci]))
    }
  }
  return{metrics,ports:Object.keys(byPort).sort(),byPort}
}

async function nsChartPanel(panel,s){
  if(!s?.nsHistoryHandles?.length){
    panel.innerHTML='<div class="not-found-msg" style="margin:16px;"><span class="nf-icon">⚠️</span><span>No <strong>nameserver_history.trc</strong> found at <code>HDB&lt;inst&gt;/&lt;host&gt;/trace/</code>.</span></div>'
    return
  }
  if(typeof Chart==='undefined'){
    panel.innerHTML='<div class="not-found-msg" style="margin:16px;"><span class="nf-icon">⚠️</span><span><strong>chartjs.min.js</strong> not found — Chart.js 4 UMD build must be in the app folder.</span></div>'
    return
  }
  panel.style.display='flex';panel.style.flexDirection='column';panel.style.overflow='hidden';panel.style.height='100%'
  panel.innerHTML=''
  const tabBar=document.createElement('div')
  tabBar.style.cssText='display:flex;border-bottom:1px solid #EDEBE9;background:#F3F2F1;padding:0 12px;overflow-x:auto;white-space:nowrap;position:sticky;top:0;z-index:10;flex-shrink:0;'
  panel.appendChild(tabBar)
  const contentDiv=document.createElement('div')
  contentDiv.style.cssText='flex:1;min-height:0;overflow:hidden;display:flex;flex-direction:column;'
  panel.appendChild(contentDiv)
  let activeHost=null,_loadGen=0
  function _switchTab(hn){
    tabBar.querySelectorAll('button').forEach(b=>{
      const a=b.dataset.host===hn
      b.style.color=a?'#0078D4':'#605E5C';b.style.borderBottom=a?'2px solid #0078D4':'2px solid transparent'
      b.style.fontWeight=a?'600':'normal';b.style.background=a?'#EFF6FC':'transparent'
    })
  }
  for(const{hostName,handle}of s.nsHistoryHandles){
    const btn=document.createElement('button')
    btn.dataset.host=hostName
    btn.style.cssText='display:inline-flex;align-items:center;gap:5px;height:36px;padding:0 14px;border:none;border-bottom:2px solid transparent;background:transparent;font-family:inherit;font-size:12px;color:#605E5C;cursor:pointer;white-space:nowrap;'
    btn.innerHTML=`🖥️ ${escHtml(hostName)}`
    btn.onclick=async()=>{
      if(activeHost===hostName)return
      activeHost=hostName;_switchTab(hostName)
      const gen=++_loadGen
      await nsChartLoadHost(contentDiv,hostName,handle,()=>gen!==_loadGen)
    }
    tabBar.appendChild(btn)
  }
  tabBar.querySelector('button')?.click()
}

async function nsChartLoadHost(container,hostName,handle,isCancelled){
  container.innerHTML='<div style="color:#A19F9D;font-size:12px;padding:16px;">Parsing nameserver_history.trc…</div>'
  try{
    const file=await handle.getFile()
    const txt=await file.text()
    if(isCancelled?.())return
    const parsed=nsChartParse(txt)
    if(isCancelled?.())return
    if(!parsed||!parsed.ports.length){
      container.innerHTML='<div class="not-found-msg" style="margin:16px;"><span class="nf-icon">⚠️</span><span>No data found in nameserver_history.trc.</span></div>'
      return
    }
    const cid='nsc-'+hostName.replace(/[^a-z0-9]/gi,'-')
    if(_nsChartState[cid]?.chart){_nsChartState[cid].chart.destroy();delete _nsChartState[cid].chart}
    _nscApplyConversions(parsed)
    // Prefer indexserver port; skip nameserver/preprocessor/stats/xsengine (last 2 digits in skip list)
    const _SKIP_SFXS=new Set(['01','02','04','05','06','07','10','11','12','29'])
    const preferredPort=parsed.ports.find(p=>!_SKIP_SFXS.has(p.slice(-2)))||parsed.ports[0]
    const defVis=new Set(parsed.metrics.filter(m=>_NSC_DEFAULT.has(m.name)).map(m=>m.name))
    if(!defVis.size)parsed.metrics.slice(0,5).forEach(m=>defVis.add(m.name))
    // Y-Scale: shared per known scale group; individual for unknown
    const sgMaxes={},indMaxes=new Array(parsed.metrics.length).fill(0)
    parsed.metrics.forEach((m,mi)=>{
      const sg=_NSC_SGROUPS[m.name]||'unknown'
      if(sg!=='unknown'&&sgMaxes[sg]==null)sgMaxes[sg]=0
      for(const p of parsed.ports){
        const vals=parsed.byPort[p].values[mi]
        for(const v of vals){
          if(!Number.isFinite(v))continue
          if(sg==='unknown'){if(v>indMaxes[mi])indMaxes[mi]=v}
          else{if(v>sgMaxes[sg])sgMaxes[sg]=v}
        }
      }
    })
    const yScaleArray=parsed.metrics.map((m,mi)=>{
      const sg=_NSC_SGROUPS[m.name]||'unknown'
      if(sg==='pct')return 100
      return _nscCalcYScale(sg==='unknown'?indMaxes[mi]:sgMaxes[sg]||0)
    })
    if(isCancelled?.())return
    _nsChartState[cid]={parsedData:parsed,hostName,visiblePort:preferredPort,visibleMetrics:defVis,fromMs:null,toMs:null,yScaleArray}
    nsChartBuildUI(container,cid)
    nsChartDraw(cid)
  }catch(e){
    container.innerHTML=`<div class="not-found-msg" style="margin:16px;"><span class="nf-icon">⚠️</span><span>Error: ${escHtml(String(e))}</span></div>`
  }
}

function _nscScaleGroup(name,unit){
  const n=name.toLowerCase(),u=(unit||'').toLowerCase()
  if(u.includes('%'))return'pct'
  if(n.includes('disk'))return'disk'
  if(n.includes('network'))return'net'
  if(n.includes('swap'))return'swap'
  if(u.includes('byte'))return'memory'
  if(n.includes('connection')||n.includes('session'))return'conn'
  if(n.includes('statement')||n.includes('sql')||n.includes('execution'))return'stmt'
  if(n.includes('transaction'))return'trans'
  if(n.includes('thread'))return'thread'
  return'other'
}

function _nscCalcYScale(maxVal){
  if(!Number.isFinite(maxVal)||maxVal<=0)return 100
  const exp=Math.floor(Math.log10(maxVal))
  const pow=Math.pow(10,exp)
  const m=maxVal/pow
  return(m<=2?2:m<=5?5:10)*pow
}

function _nscFmtYScale(v){if(!Number.isFinite(v))return'—';if(v>=1e9)return(v/1e9).toFixed(0)+'B';if(v>=1e6)return(v/1e6).toFixed(0)+'M';if(v>=1000)return(v/1000).toFixed(0)+'K';return String(Math.round(v))}
function _nscSid(s){return s.replace(/[^a-zA-Z0-9]/g,'_')}


function _nscMsToDatetimeLocal(ms){const d=new Date(ms),p=n=>String(n).padStart(2,'0');return`${d.getFullYear()}-${p(d.getMonth()+1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}`}
function _nscAxisLabel(unit){if(!unit)return 'Auto';if(unit.includes('%'))return '0–100%';if(unit.toLowerCase().includes('byte'))return 'Auto';return 'Auto'}
function _nscFmtStat(v,unit){if(!Number.isFinite(v))return '—';if(unit?.toLowerCase().includes('byte'))return _nscFmtBytes(v);if(Math.abs(v)>=1e6)return(v/1e6).toFixed(1)+'M';if(Math.abs(v)>=1000)return Math.round(v).toLocaleString();return v%1===0?String(v):v.toFixed(2)}

function nsChartToggleRefs(btn,cid){
  const pid=cid+'-refs-pop'
  let pop=document.getElementById(pid)
  if(pop){pop.remove();return}
  pop=document.createElement('div')
  pop.id=pid
  pop.style.cssText='position:absolute;top:calc(100% + 4px);right:0;background:#fff;border:1px solid #EDEBE9;border-radius:2px;box-shadow:0 4px 12px rgba(0,0,0,.15);z-index:9999;padding:12px 16px;font-size:12px;min-width:340px;'
  pop.innerHTML=`<div style="font-weight:600;margin-bottom:8px;color:#323130;">References</div>
<div style="display:flex;flex-direction:column;gap:7px;">
<a href="https://me.sap.com/notes/3367214" target="_blank" style="color:#0078D4;text-decoration:none;display:flex;align-items:center;gap:6px;">📋 KBA 3367214 — HANA Nameserver History</a>
<a href="https://github.com/ckyycc/ngx-hana-nameserver-history-viewer" target="_blank" style="color:#0078D4;text-decoration:none;display:flex;align-items:center;gap:6px;">🐙 GitHub — ngx-hana-nameserver-history-viewer</a>
<a href="https://ckyycc.github.io/ngx-hana-nameserver-history-viewer/" target="_blank" style="color:#0078D4;text-decoration:none;display:flex;align-items:center;gap:6px;">🌐 Live Demo (GitHub Pages)</a>
<a href="http://nshviewer.cfapps.sap.hana.ondemand.com" target="_blank" style="color:#0078D4;text-decoration:none;display:flex;align-items:center;gap:6px;">🌐 Live Demo (SAP Cloud)</a>
</div>`
  const toolbar=btn.closest('.nsc-toolbar')||btn.parentNode
  toolbar.style.position='relative'
  toolbar.appendChild(pop)
  function closeOnOutside(e){if(!pop.contains(e.target)&&e.target!==btn){pop.remove();document.removeEventListener('click',closeOnOutside,true)}}
  setTimeout(()=>document.addEventListener('click',closeOnOutside,true),0)
}

function nsChartBuildUI(container,cid){
  const st=_nsChartState[cid]
  const{parsedData:{metrics,ports},hostName,visiblePort,visibleMetrics}=st

  const portSvcMap={}
  if(topoData){const h=topoData.hosts.find(h=>h.name===hostName);if(h)h.services.forEach(s=>portSvcMap[String(s.port)]=s.name)}
  const portLbl=p=>{const s=portSvcMap[p];return s?`${p} — ${s}`:p}

  // Use hardcoded group map (reference tool order); unknown metrics fall into 'Other'
  const GROUP_ORDER=['Host','Service','SQL','Row Store','Column Store','Threads','Persistence','Backup','Synchronization Primitives','Session Admission Control','Other']
  const groupMap={}
  metrics.forEach(m=>{const g=_NSC_GROUPS[m.name]||'Other';if(!groupMap[g])groupMap[g]=[];groupMap[g].push(m)})
  const groups=GROUP_ORDER.filter(g=>groupMap[g]?.length).map(g=>({id:g.toLowerCase().replace(/[^a-z0-9]/g,'-'),label:g,metrics:groupMap[g]}))

  const portData=st.parsedData.byPort[visiblePort]
  const dtFrom=portData?.timestamps.length?_nscMsToDatetimeLocal(portData.timestamps[0]):''
  const dtTo=portData?.timestamps.length?_nscMsToDatetimeLocal(portData.timestamps[portData.timestamps.length-1]):''
  const tzLabel=Intl.DateTimeFormat().resolvedOptions().timeZone
  const rangeInfo=portData?.timestamps.length?` (${_nscFmtTs(portData.timestamps[0])} – ${_nscFmtTs(portData.timestamps[portData.timestamps.length-1])})`:''

  const portSel=ports.length>1
    ?`<select id="${cid}-portsel" class="nsc-select" onchange="nsChartSwitchPortSel('${cid}')">${ports.map(p=>`<option value="${escHtml(p)}"${p===visiblePort?' selected':''}>${escHtml(portLbl(p))}</option>`).join('')}</select>`
    :`<span class="nsc-port-tag">${escHtml(portLbl(visiblePort))}</span>`

  let html=`<div class="nsc-toolbar">
    <label>Date Time Range From:</label>
    <input type="datetime-local" id="${cid}-from" class="nsc-dt-input" value="${dtFrom}">
    <label>To:</label>
    <input type="datetime-local" id="${cid}-to" class="nsc-dt-input" value="${dtTo}">
    <span class="nsc-tz">${escHtml(tzLabel)}</span>
    ${portSel}
    <button class="nsc-btn-primary" onclick="nsChartShow('${cid}')">Show</button>
    <button class="nsc-btn" onclick="nsChartReset('${cid}')">Reset Chart</button>
    <button class="nsc-btn" onclick="nsChartToggleRefs(this,'${cid}')">References</button>
    <span id="${cid}-info" class="nsc-tz"></span>
  </div>
  <div class="nsc-range-info" id="${cid}-range-info">${escHtml(hostName)} · ${escHtml(portLbl(visiblePort))}${escHtml(rangeInfo)}</div>
  <div class="nsc-body">
    <div class="nsc-chart-area"><canvas id="${cid}-canvas"></canvas></div>
    <div class="nsc-param-panel">
      <input type="search" id="${cid}-search" class="nsc-search" placeholder="🔍 Enter Search Terms Here" oninput="nsChartFilter('${cid}',this.value)">
      <div class="nsc-param-header">
        <span>KPI</span><span style="text-align:center;">Y-Scale</span><span style="text-align:center;">Unit</span>
        <span style="text-align:right;">Max</span><span style="text-align:right;">Average</span>
      </div>
      <div class="nsc-param-rows" id="${cid}-param-rows">`

  groups.forEach(g=>{
    html+=`<div class="nsc-param-group" id="${cid}-grp-${g.id}"><div class="nsc-group-hdr" onclick="nsChartToggleGroup(this)">▼ ${escHtml(g.label)}</div>`
    g.metrics.forEach(m=>{
      const mi=metrics.indexOf(m)
      const color=_NSC_PALETTE[mi%_NSC_PALETTE.length]
      const chk=visibleMetrics.has(m.name)
      html+=`<div class="nsc-param-row${chk?' checked':''}" data-metric="${escHtml(m.name)}" data-label="${escHtml(m.label)}" id="${cid}-row-${_nscSid(m.name)}" style="border-left-color:${chk?color:'transparent'};">
        <span class="nsc-param-kpi">
          <input type="checkbox"${chk?' checked':''} data-metric="${escHtml(m.name)}" data-color="${color}" onchange="nsChartToggleMetric('${cid}',this.dataset.metric,this.checked)" style="cursor:pointer;margin:0;flex-shrink:0;">
          <span title="${escHtml(m.label)}" style="overflow:hidden;text-overflow:ellipsis;white-space:nowrap;">${escHtml(_NSC_LABELS[m.name]||m.name)}</span>
        </span>
        <span class="nsc-param-scale" style="text-align:center;cursor:default;" title="Auto-computed Y-axis max">${escHtml(_nscFmtYScale(st.yScaleArray?.[mi]))}</span>
        <span class="nsc-param-unit">${escHtml(m.unit||'')}</span>
        <span class="nsc-param-stat" id="${cid}-max-${_nscSid(m.name)}">—</span>
        <span class="nsc-param-stat" id="${cid}-avg-${_nscSid(m.name)}">—</span>
      </div>`
    })
    html+=`</div>`
  })
  html+=`</div></div></div>`
  container.innerHTML=html
}

function nsChartUpdateStats(cid){
  const st=_nsChartState[cid];if(!st)return
  const portData=st.parsedData.byPort[st.visiblePort];if(!portData)return
  const ts=portData.timestamps
  const{fromMs,toMs}=st
  let iStart=0,iEnd=ts.length
  if(fromMs!=null){let found=false;for(let i=0;i<ts.length;i++){if(ts[i]>=fromMs){iStart=i;found=true;break}};if(!found)iStart=ts.length}
  if(toMs!=null){let found=false;for(let i=ts.length-1;i>=iStart;i--){if(ts[i]<=toMs){iEnd=i+1;found=true;break}};if(!found)iEnd=iStart}
  st.parsedData.metrics.forEach((m,mi)=>{
    const vals=portData.values[mi]
    let max=-Infinity,sum=0,cnt=0
    for(let i=iStart;i<iEnd;i++){const v=vals[i];if(!Number.isFinite(v))continue;if(v>max)max=v;sum+=v;cnt++}
    const fmt=v=>_nscFmtStat(v,m.unit)
    const sid=_nscSid(m.name)
    const eMx=document.getElementById(cid+'-max-'+sid),eAv=document.getElementById(cid+'-avg-'+sid)
    if(eMx)eMx.textContent=cnt?fmt(max):'—'
    if(eAv)eAv.textContent=cnt?fmt(sum/cnt):'—'
  })
}

function nsChartUpdateRowVisuals(cid){
  const st=_nsChartState[cid];if(!st)return
  st.parsedData.metrics.forEach((m,mi)=>{
    const row=document.getElementById(cid+'-row-'+_nscSid(m.name));if(!row)return
    const vis=st.visibleMetrics.has(m.name)
    const color=_NSC_PALETTE[mi%_NSC_PALETTE.length]
    row.style.borderLeftColor=vis?color:'transparent'
    row.classList.toggle('checked',vis)
    const cb=row.querySelector('input[type=checkbox]');if(cb)cb.checked=vis
  })
}

function nsChartDraw(cid){
  const st=_nsChartState[cid];if(!st)return
  const canvas=document.getElementById(cid+'-canvas');if(!canvas)return
  const{parsedData,visiblePort,visibleMetrics,fromMs,toMs}=st
  const portData=parsedData.byPort[visiblePort];if(!portData)return
  if(st.chart){st.chart.destroy();st.chart=null}
  const ts=portData.timestamps
  let iStart=0,iEnd=ts.length
  if(fromMs!=null){let found=false;for(let i=0;i<ts.length;i++){if(ts[i]>=fromMs){iStart=i;found=true;break}};if(!found)iStart=ts.length}
  if(toMs!=null){let found=false;for(let i=ts.length-1;i>=iStart;i--){if(ts[i]<=toMs){iEnd=i+1;found=true;break}};if(!found)iEnd=iStart}
  const filteredTs=ts.slice(iStart,iEnd)
  const MAX=1500
  const datasets=parsedData.metrics.map((m,mi)=>{
    const hidden=!visibleMetrics.has(m.name)
    const{xs,ys}=_nscLttb(filteredTs,portData.values[mi].slice(iStart,iEnd),MAX)
    return{
      label:m.label,data:xs.map((x,i)=>({x,y:ys[i]})),
      borderColor:_NSC_PALETTE[mi%_NSC_PALETTE.length],
      backgroundColor:_NSC_PALETTE[mi%_NSC_PALETTE.length]+'18',
      borderWidth:1.5,pointRadius:0,pointHoverRadius:3,tension:0.2,hidden
    }
  })
  const spanMs=filteredTs.length>1?filteredTs[filteredTs.length-1]-filteredTs[0]:0
  const MNTHS=['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec']
  const xTickCb=v=>{const d=new Date(v),hh=String(d.getHours()).padStart(2,'0'),mm=String(d.getMinutes()).padStart(2,'0');return spanMs>86400000?`${MNTHS[d.getMonth()]}${d.getDate()} ${hh}:${mm}`:`${hh}:${mm}`}
  const scales={x:{type:'linear',ticks:{maxTicksLimit:8,callback:xTickCb,maxRotation:0},grid:{color:'rgba(0,0,0,0.05)'}}}
  const yScaleArr=st.yScaleArray||new Array(parsedData.metrics.length).fill(100)
  const firstVisIdx=datasets.findIndex(d=>!d.hidden)
  datasets.forEach((dataset,mi)=>{
    const ys=yScaleArr[mi]||100
    scales['y-'+mi]={type:'linear',display:false,min:0,max:ys,grid:{drawOnChartArea:mi===(firstVisIdx>=0?firstVisIdx:0),color:'rgba(0,0,0,0.06)'}}
    dataset.yAxisID='y-'+mi
  })
  st.chart=new Chart(canvas,{type:'line',data:{datasets},options:{
    responsive:true,maintainAspectRatio:false,animation:false,
    interaction:{intersect:false,mode:'index'},
    plugins:{
      legend:{display:false},
      tooltip:{callbacks:{
        title:items=>_nscFmtTs(items[0]?.parsed?.x||0),
        label:item=>{if(item.dataset.hidden)return null;const m=parsedData.metrics[item.datasetIndex];const unit=m?.unit||'';const v=item.parsed.y;const valStr=typeof v==='number'?v.toLocaleString(undefined,{maximumFractionDigits:2}):'-';return unit&&!unit.includes('%')?`${item.dataset.label}: ${valStr} ${unit}`:`${item.dataset.label}: ${valStr}`}
      }}
    },
    scales
  }})
  const info=document.getElementById(cid+'-info')
  if(info)info.textContent=`${filteredTs.length.toLocaleString()} pts${filteredTs.length>MAX?` · LTTB→${MAX}`:''}`
  nsChartUpdateStats(cid)
}

function nsChartShow(cid){
  const st=_nsChartState[cid];if(!st)return
  const fv=document.getElementById(cid+'-from')?.value
  const tv=document.getElementById(cid+'-to')?.value
  st.fromMs=fv?new Date(fv).getTime():null
  st.toMs=tv?new Date(tv).getTime():null
  nsChartDraw(cid)
}

function nsChartReset(cid){
  const st=_nsChartState[cid];if(!st)return
  st.fromMs=null;st.toMs=null
  const portData=st.parsedData.byPort[st.visiblePort]
  if(portData?.timestamps.length){
    const fe=document.getElementById(cid+'-from'),te=document.getElementById(cid+'-to')
    if(fe)fe.value=_nscMsToDatetimeLocal(portData.timestamps[0])
    if(te)te.value=_nscMsToDatetimeLocal(portData.timestamps[portData.timestamps.length-1])
  }
  nsChartDraw(cid)
}

function nsChartSwitchPort(cid,port){
  const st=_nsChartState[cid];if(!st||st.visiblePort===port)return
  st.visiblePort=port
  const portData=st.parsedData.byPort[port]
  if(portData?.timestamps.length){
    const fe=document.getElementById(cid+'-from'),te=document.getElementById(cid+'-to')
    // Only reset datetime inputs when the user has no active filter
    if(st.fromMs==null&&st.toMs==null){
      if(fe)fe.value=_nscMsToDatetimeLocal(portData.timestamps[0])
      if(te)te.value=_nscMsToDatetimeLocal(portData.timestamps[portData.timestamps.length-1])
    }
  }
  const ri=document.getElementById(cid+'-range-info')
  if(ri){const portSvcMap={};if(topoData){const h=topoData.hosts.find(h=>h.name===st.hostName);if(h)h.services.forEach(s=>portSvcMap[String(s.port)]=s.name)};const s=portSvcMap[port];const lbl=s?`${port} — ${s}`:port;ri.textContent=`${st.hostName} · ${lbl}`+(portData?.timestamps.length?` (${_nscFmtTs(portData.timestamps[0])} – ${_nscFmtTs(portData.timestamps[portData.timestamps.length-1])})`:'')}
  nsChartDraw(cid)
}

function nsChartSwitchPortSel(cid){const sel=document.getElementById(cid+'-portsel');if(sel)nsChartSwitchPort(cid,sel.value)}

function nsChartToggleMetric(cid,name,visible){
  const st=_nsChartState[cid];if(!st)return
  if(visible)st.visibleMetrics.add(name);else st.visibleMetrics.delete(name)
  const mi=st.parsedData.metrics.findIndex(m=>m.name===name)
  const row=document.getElementById(cid+'-row-'+_nscSid(name))
  if(row){row.style.borderLeftColor=visible?_NSC_PALETTE[mi%_NSC_PALETTE.length]:'transparent';row.classList.toggle('checked',visible)}
  nsChartDraw(cid)
}

function nsChartSelCat(cid,cat){
  const st=_nsChartState[cid];if(!st)return
  const metrics=st.parsedData.metrics
  if(cat==='all')metrics.forEach(m=>st.visibleMetrics.add(m.name))
  else if(cat==='none')st.visibleMetrics.clear()
  else metrics.filter(m=>_nscCat(m.name)===cat).forEach(m=>st.visibleMetrics.add(m.name))
  nsChartUpdateRowVisuals(cid)
  nsChartDraw(cid)
}

function nsChartFilter(cid,query){
  const q=query.toLowerCase().trim()
  const rows=document.getElementById(cid+'-param-rows');if(!rows)return
  rows.querySelectorAll('.nsc-param-row').forEach(r=>{r.style.display=!q||((r.dataset.label||'').toLowerCase().includes(q)||(r.dataset.metric||'').toLowerCase().includes(q))?'':'none'})
  rows.querySelectorAll('.nsc-param-group').forEach(g=>{g.style.display=[...g.querySelectorAll('.nsc-param-row')].some(r=>r.style.display!=='none')?'':'none'})
}

function nsChartToggleGroup(hdr){
  const open=hdr.textContent.startsWith('▼')
  hdr.textContent=(open?'▶':'▼')+hdr.textContent.slice(1)
  hdr.parentElement.querySelectorAll('.nsc-param-row').forEach(r=>r.style.display=open?'none':'')
}

function renderTelemetry(text){
  const lines=text.split('\n').map(l=>l.replace(/\r$/,'')).filter(l=>l.trim())
  if(lines.length<2)return '<div class="not-found-msg"><span class="nf-icon">⚠️</span><span>telemetryData.csv is empty or invalid.</span></div>'
  const headers=lines[0].split(';')
  const rows=lines.slice(1).map(l=>l.split(';'))

  let html=`<div class="card"><div class="card-title">📡 Telemetry Data <span style="font-weight:400;font-size:11px;color:#605E5C;">${rows.length} rows &nbsp;|&nbsp; telemetryData.csv</span></div>
  <div style="overflow-x:auto;max-height:calc(100vh - 160px);overflow-y:auto;">
  <table class="data-table" style="white-space:nowrap;width:auto;min-width:100%;">
  <thead style="position:sticky;top:0;z-index:5;"><tr>`
  for(const h of headers)html+=`<th>${escHtml(h)}</th>`
  html+=`</tr></thead><tbody>`

  for(const row of rows){
    const isDeprecated=row[2]==='1'
    html+=`<tr${isDeprecated?' style="opacity:0.5;"':''}>`
    for(let i=0;i<headers.length;i++){
      const val=row[i]??''
      if(i===2){
        html+=`<td>${val==='1'?tag('tag-warn','deprecated'):tag('tag-green','active')}</td>`
      } else {
        html+=`<td><span class="mono">${escHtml(val)}</span></td>`
      }
    }
    html+=`</tr>`
  }
  html+=`</tbody></table></div></div>`
  return html
}

function renderTopologyApp(data,container){
  container.innerHTML=''
  const tabBar=document.createElement('div')
  tabBar.style.cssText='display:flex;border-bottom:1px solid #EDEBE9;background:#F3F2F1;padding:0 12px;overflow-x:auto;white-space:nowrap;position:sticky;top:0;z-index:10;'
  container.appendChild(tabBar)
  const panelsDiv=document.createElement('div')
  panelsDiv.style.cssText='padding:16px;'
  container.appendChild(panelsDiv)
  const tabs=[{key:'dashboard',label:'Dashboard',icon:'📊'},...data.hosts.map(h=>({key:'host-'+h.name,label:h.name,icon:'🖥️'})),{key:'raw-tree',label:'Raw Tree',icon:'🌲'}]
  function switchTab(key){
    tabBar.querySelectorAll('button').forEach(b=>{const a=b.dataset.key===key;b.style.color=a?'#0078D4':'#605E5C';b.style.borderBottom=a?'2px solid #0078D4':'2px solid transparent';b.style.fontWeight=a?'600':'normal';b.style.background=a?'#EFF6FC':'transparent'})
    panelsDiv.querySelectorAll('.topo-panel').forEach(p=>{p.style.display=p.dataset.key===key?'block':'none'})
    if(key==='dashboard'&&data.replicationRows.length)requestAnimationFrame(()=>drawTopology(data))
  }
  for(const t of tabs){const btn=document.createElement('button');btn.dataset.key=t.key;btn.style.cssText='display:inline-flex;align-items:center;gap:5px;height:36px;padding:0 14px;border:none;border-bottom:2px solid transparent;background:transparent;font-family:inherit;font-size:12px;color:#605E5C;cursor:pointer;white-space:nowrap;';btn.innerHTML=`${t.icon} ${escHtml(t.label)}`;btn.onclick=()=>switchTab(t.key);tabBar.appendChild(btn)}
  const dashPanel=document.createElement('div');dashPanel.className='topo-panel';dashPanel.dataset.key='dashboard';dashPanel.innerHTML=renderDashboard(data);panelsDiv.appendChild(dashPanel)
  if(data.replicationRows.length)requestAnimationFrame(()=>drawTopology(data))
  for(const h of data.hosts){const hPanel=document.createElement('div');hPanel.className='topo-panel';hPanel.dataset.key='host-'+h.name;hPanel.style.display='none';const pid=`hp-${h.name.replace(/[^a-z0-9]/gi,'-')}`;hPanel.innerHTML=renderHostPanel(h,pid);panelsDiv.appendChild(hPanel)}
  const rtPanel=document.createElement('div');rtPanel.className='topo-panel';rtPanel.dataset.key='raw-tree';rtPanel.style.display='none';rtPanel.innerHTML=`<input id="rawSearch" placeholder="🔍 Filter nodes…" oninput="applyTreeSearch(this.value)"><div id="rawTree">${data.rawTree.map(n=>renderTreeNode(n,0)).join('')}</div>`;panelsDiv.appendChild(rtPanel)
  switchTab('dashboard')
}

// ══════════════════════════════════════════════════════════════════════════
// HSI — HANASupportInfo Integration
// ══════════════════════════════════════════════════════════════════════════

// ── Minimal Markdown renderer (for md_* files) ────────────────────────────
function mdInline(raw){
  let s=escHtml(raw)
  s=s.replace(/`([^`]+)`/g,'<code style="background:#F3F2F1;padding:1px 4px;border-radius:2px;font-family:Consolas,monospace;font-size:0.9em;">$1</code>')
  s=s.replace(/\*\*([^*]+)\*\*/g,'<strong>$1</strong>')
  s=s.replace(/__([^_]+)__/g,'<strong>$1</strong>')
  s=s.replace(/\*([^*\n]+)\*/g,'<em>$1</em>')
  s=s.replace(/_([^_\n]+)_/g,'<em>$1</em>')
  s=s.replace(/\[([^\]]+)\]\(([^)]+)\)/g,'<a href="$2" style="color:#0078D4;" target="_blank">$1</a>')
  s=s.replace(/<strong>WARNING:<\/strong>/g,'<strong style="color:#A4262C;">WARNING:</strong>')
  s=s.replace(/<strong>PASSED:<\/strong>/g,'<strong style="color:#107C10;">PASSED:</strong>')
  return s
}
function renderMdTable(lines){
  const rows=lines.map(l=>l.trim().replace(/^\||\|$/g,'').split('|').map(c=>c.trim()))
  const sepIdx=rows.findIndex(r=>r.every(c=>/^[-: ]+$/.test(c)))
  const head=rows[0]||[]
  const body=rows.slice(sepIdx>=0?sepIdx+1:1)
  let t='<table style="border-collapse:collapse;font-size:12px;margin:10px 0;width:100%;">'
  t+='<thead><tr>'+head.map(c=>`<th style="border:1px solid #EDEBE9;padding:6px 10px;background:#F3F2F1;font-weight:600;text-align:left;white-space:nowrap;">${mdInline(c)}</th>`).join('')+'</tr></thead>'
  t+='<tbody>'+body.map((r,ri)=>'<tr>'+r.map(c=>`<td style="border:1px solid #EDEBE9;padding:5px 10px;${ri%2?'background:#FAFAFA;':''}">${mdInline(c)}</td>`).join('')+'</tr>').join('')+'</tbody>'
  return t+'</table>'
}
function renderMarkdown(md){
  const lines=md.replace(/\r\n/g,'\n').replace(/\r/g,'\n').split('\n')
  // First pass: collect H1/H2 headings for TOC and assign anchors (skip inside code fences)
  const headAnchors=new Map()  // line-index → anchor-id
  const tocEntries=[]
  let anchorCtr=0,inFence=false
  for(let li=0;li<lines.length;li++){
    if(/^```/.test(lines[li].trim())){inFence=!inFence;continue}
    if(inFence)continue
    const hm=lines[li].match(/^(#{1,2})\s+(.+)/)
    if(hm){
      const id=`hsi-md-${anchorCtr++}`
      headAnchors.set(li,id)
      const lvl=hm[1].length
      const text=hm[2].replace(/[*_`[\]]/g,'').trim()
      tocEntries.push(`<li style="${lvl>1?'padding-left:12px;':''}"><a href="#${id}">${escHtml(text)}</a></li>`)
    }
  }
  const TOP_BTN=`<a href="#hsi-top" style="font-size:0.76em;text-decoration:none;color:#6c757d;padding:2px 8px;border:1px solid #dee2e6;border-radius:12px;white-space:nowrap;flex-shrink:0;">▲ TOP</a>`
  let html=tocEntries.length>1
    ?`<div id="hsi-top" class="hsi-toc"><strong>Contents</strong><ul>${tocEntries.join('')}</ul></div>`
    :`<a id="hsi-top"></a>`
  let i=0
  while(i<lines.length){
    const line=lines[i]
    // Fenced code block
    if(/^```/.test(line.trim())){
      const codeLines=[];i++
      while(i<lines.length&&!/^```/.test(lines[i].trim())){codeLines.push(lines[i]);i++}
      i++
      const codeHtml=codeLines.map(l=>{let s=escHtml(l);return s.replace(/\[([^\]]+)\]\(([^)]+)\)/g,'<a href="$2" style="color:#0078D4;text-decoration:none;" target="_blank">$1</a>')}).join('\n')
      html+=`<pre style="background:#F3F2F1;border:1px solid #EDEBE9;border-radius:3px;padding:10px 12px;white-space:pre-wrap;word-break:break-word;font-family:Consolas,monospace;font-size:11px;line-height:1.5;margin:8px 0;"><code>${codeHtml}</code></pre>`
      continue
    }
    // Heading
    const hm=line.match(/^(#{1,6})\s+(.+)/)
    if(hm){
      const lvl=hm[1].length
      const sz=['1.5em','1.3em','1.15em','1.05em','1em','1em'][lvl-1]
      const anchor=headAnchors.get(i)
      if(anchor){
        html+=`<h${lvl} id="${anchor}" style="margin:18px 0 6px;font-size:${sz};font-weight:700;color:#1a1a1a;display:flex;align-items:center;justify-content:space-between;"><span>${mdInline(hm[2])}</span>${TOP_BTN}</h${lvl}>`
      }else{
        const bb=lvl<=2?'border-bottom:1px solid #EDEBE9;padding-bottom:4px;':''
        html+=`<h${lvl} style="margin:${lvl<=2?18:12}px 0 6px;font-size:${sz};font-weight:${lvl<=2?700:600};${bb}color:#1a1a1a;">${mdInline(hm[2])}</h${lvl}>`
      }
      i++;continue
    }
    // Horizontal rule
    if(/^[-*_]{3,}\s*$/.test(line)){html+='<hr style="border:none;border-top:1px solid #EDEBE9;margin:14px 0;">';i++;continue}
    // Blockquote
    if(/^>\s/.test(line)){
      const bqLines=[]
      while(i<lines.length&&/^>\s?/.test(lines[i])){bqLines.push(lines[i].replace(/^>\s?/,''));i++}
      html+=`<blockquote style="border-left:3px solid #0078D4;margin:8px 0;padding:4px 12px;background:#F5F9FF;color:#323130;">${bqLines.map(l=>mdInline(l)).join('<br>')}</blockquote>`
      continue
    }
    // Table — pipe at line start (pipe-fenced rows with or without separator)
    if(line.trimStart().startsWith('|')){
      const tLines=[]
      while(i<lines.length&&lines[i].trimStart().startsWith('|')){tLines.push(lines[i]);i++}
      html+=renderMdTable(tLines);continue
    }
    // Unordered list
    if(/^[-*+]\s/.test(line)){
      const items=[]
      while(i<lines.length&&(/^[-*+]\s/.test(lines[i])||/^\s{2,}[-*+]\s/.test(lines[i]))){
        if(/^[-*+]\s/.test(lines[i]))items.push(lines[i].replace(/^[-*+]\s+/,'').trim())
        i++
      }
      html+='<ul style="margin:6px 0;padding-left:22px;">'+items.map(it=>`<li style="margin:2px 0;">${mdInline(it)}</li>`).join('')+'</ul>'
      continue
    }
    // Ordered list
    if(/^\d+\.\s/.test(line)){
      const items=[]
      while(i<lines.length&&/^\d+\.\s/.test(lines[i])){items.push(lines[i].replace(/^\d+\.\s+/,'').trim());i++}
      html+='<ol style="margin:6px 0;padding-left:22px;">'+items.map(it=>`<li style="margin:2px 0;">${mdInline(it)}</li>`).join('')+'</ol>'
      continue
    }
    // Blank line
    if(line.trim()===''){i++;continue}
    // Paragraph
    const paraLines=[]
    while(i<lines.length&&lines[i].trim()!==''&&!/^#{1,6}\s/.test(lines[i])&&!/^[-*+]\s/.test(lines[i])&&!/^\d+\.\s/.test(lines[i])&&!/^```/.test(lines[i].trim())&&!/^[-*_]{3,}\s*$/.test(lines[i])&&!/^>\s/.test(lines[i])&&!lines[i].includes('|')){
      paraLines.push(lines[i]);i++
    }
    if(paraLines.length)html+=`<p style="margin:6px 0;line-height:1.6;">${paraLines.map(l=>mdInline(l)).join('<br>')}</p>`
    else i++ // safety: skip unrecognized line to prevent infinite loop
  }
  return html
}

// Fixed tab order + group definitions (mirrors the bash script)
const HSI_ORDER = [
  'GROUP:START',
  'GROUP:OS_Information',
  'GROUP:Filesystemdetails',
  'GROUP:Volumes',
  'GROUP:Network',
  'Users_Groups.log',
  'Security.log',
  'Backup.log',
  'Cluster.log',
  'HANA_DB.log',
  'GROUP:HANA_Custom_Config',
  'GROUP:Replication',
  'GROUP:SLD',
  'SDA.log',
  'Warning_Overview.log',
]
const HSI_GROUPS_BASE = {
  'START': ['00_Initialization.log','01_Overview.log'],
  'OS_Information': ['Host_Information.log','CPU.log','Memory.log'],
  'Filesystemdetails': ['Filesystemdetails_General.log','Filesystemdetails_Permissions.log','Filesystemdetails.log'],
  'Volumes': ['DATA_Volume.log','LOG_Volume.log','SHARED_Volume.log','var_tmp.log'],
  'Network': ['Network_Test.log','Network_OS.log','Network_HANA.log'],
  'Replication': ['Replication_Overview.log','Replication_Statistics.log'],
  'SLD': ['SLD.log','sld_related_nameserver-trace-analyze.log'],
}

async function _hsiScanConfigFolder(configDir, s, dirHandle){
  const hsiConfigData = {databases:[], refHandles:{}, parsedRef:null}
  const dbDirNames=[], dbDirSet=new Set()
  try{for await(const[n,h]of configDir.entries()){if(h.kind==='directory'&&n!=='reference'){dbDirNames.push(n);dbDirSet.add(n)}}}catch(e){}
  if(!dbDirSet.has('SYSTEMDB'))dbDirNames.push('SYSTEMDB')
  const _hsiSidM=dirHandle.name.match(/^HSI_([A-Z][A-Z0-9]{1,})_/i)
  if(_hsiSidM){const g='DB_'+_hsiSidM[1].toUpperCase();if(!dbDirSet.has(g))dbDirNames.push(g)}
  try{
    const refDir=await configDir.getDirectoryHandle('reference')
    try{for await(const[n,h]of refDir.entries()){if(h.kind==='file'&&n.endsWith('.ini'))hsiConfigData.refHandles[n]=h}}catch(e){}
    for(const fn of HANA_INI_FILES){if(!hsiConfigData.refHandles[fn]){try{hsiConfigData.refHandles[fn]=await refDir.getFileHandle(fn)}catch(e){}}}
  }catch(e){}
  for(const dbName of dbDirNames){
    try{
      const dbDir=await configDir.getDirectoryHandle(dbName)
      const iniHandles=[], found=new Set()
      try{for await(const[fn,fh]of dbDir.entries()){if(fh.kind==='file'&&fn.endsWith('.ini')){iniHandles.push({name:fn,handle:fh});found.add(fn)}}}catch(e){}
      for(const fn of HANA_INI_FILES){if(!found.has(fn)){try{const fh=await dbDir.getFileHandle(fn);iniHandles.push({name:fn,handle:fh})}catch(e){}}}
      if(iniHandles.length){iniHandles.sort((a,b)=>a.name.localeCompare(b.name));hsiConfigData.databases.push({name:dbName,iniHandles})}
    }catch(e){}
  }
  hsiConfigData.databases.sort((a,b)=>a.name==='SYSTEMDB'?-1:b.name==='SYSTEMDB'?1:a.name.localeCompare(b.name))
  if(hsiConfigData.databases.length) s.hsiConfigData=hsiConfigData
}

async function _hsiScanLcmFolder(lcmRoot, s){
  const lcmData = {tools:[]}
  for await(const [tname,thandle] of lcmRoot.entries()){
    if(thandle.kind!=='directory') continue
    const tool={name:tname,handle:thandle,flatFiles:[],opFolders:[]}
    for await(const [fname,fhandle] of thandle.entries()){
      if(fhandle.kind==='file') tool.flatFiles.push({name:fname,handle:fhandle})
      else if(fhandle.kind==='directory'){
        const opFiles=[]
        try{for await(const [ofname,ofhandle] of fhandle.entries()){if(ofhandle.kind==='file')opFiles.push({name:ofname,handle:ofhandle})}}catch(e){}
        opFiles.sort((a,b)=>a.name.localeCompare(b.name))
        tool.opFolders.push({name:fname,handle:fhandle,files:opFiles})
      }
    }
    tool.flatFiles.sort((a,b)=>a.name.localeCompare(b.name))
    tool.opFolders.sort((a,b)=>b.name.localeCompare(a.name))
    lcmData.tools.push(tool)
  }
  lcmData.tools.sort((a,b)=>a.name.localeCompare(b.name))
  if(lcmData.tools.length) s.hsiLcmLogsData=lcmData
}

function _hsiParseDynGroups(s){
  const groupMap = new Map()
  function ensureGroup(order, name){
    if(!groupMap.has(name)) groupMap.set(name, {order, displayName:name.replace(/_/g,' '), name, tabs:[]})
    return groupMap.get(name)
  }
  // Files from temp/ matching NN-GroupName--MM-TabName.(md|log)
  // Use handle.name for original casing (s.hsiFiles keys are lowercase)
  for(const [fname, handle] of Object.entries(s.hsiFiles)){
    const srcName = (handle && handle.name) || fname
    const m = srcName.match(/^(\d+)-(.+?)--(\d+)-(.+)\.(md|log)$/i)
    if(!m) continue
    const grp = ensureGroup(parseInt(m[1]), m[2])
    grp.tabs.push({
      order:parseInt(m[3]), id:'dyntab-'+fname, label:m[4].replace(/_/g,' '),
      type: m[4].toLowerCase().includes('permissions') ? 'dyn-perm' : 'dyn-md',
      file:fname, handle
    })
  }
  // Root tab-folders: NN-GroupName--MM-FolderName (already properly cased from filesystem)
  for(const rf of s.hsiRootFolders){
    if(!rf.isTabFolder) continue
    const grp = ensureGroup(rf.order, rf.groupName)
    grp.tabs.push({
      order:rf.tabOrder, id:'dyntabfol-'+rf.rawName, label:rf.tabName.replace(/_/g,' '),
      type:'dyn-explorer', handle:rf.handle
    })
  }
  // Top-level numbered folders (no --): merge into existing tab-group if same name exists
  for(const rf of s.hsiRootFolders){
    if(rf.isTabFolder) continue
    const isConfig = /configuration/i.test(rf.folderName) && s.hsiConfigData
    const isLcm = /lcm/i.test(rf.folderName) && s.hsiLcmLogsData
    const sameGrp = [...groupMap.values()].find(g => !g.isTopLevel && g.name.toLowerCase() === rf.folderName.toLowerCase())
    if(sameGrp){
      // Merge folder as extra tab inside the existing group
      sameGrp.tabs.push({
        order: isConfig ? 0 : 999,
        id: 'dyntabfol-top-'+rf.rawName,
        label: isConfig ? 'HANA INI Config' : rf.folderName.replace(/_/g,' '),
        type: isConfig ? 'dyn-config' : 'dyn-explorer',
        handle: rf.handle
      })
    } else {
      groupMap.set('__top__'+rf.folderName, {
        order:rf.order, displayName:rf.folderName.replace(/_/g,' '), name:rf.folderName,
        isTopLevel:true, type:isConfig?'dyn-config':isLcm?'lcm-logs':'dyn-explorer',
        handle:rf.handle, tabs:[]
      })
    }
  }
  return [...groupMap.values()]
    .filter(g => g.tabs.length > 0 || g.isTopLevel)
    .sort((a,b) => a.order - b.order)
    .map(g => { g.tabs.sort((a,b)=>a.order-b.order); return g })
}

async function loadHSIFolder(existingHandle){
  try{
    const dirHandle = existingHandle || await window.showDirectoryPicker({mode:'read',id:'load-hsi',...(_lastPickedHandle?{startIn:_lastPickedHandle}:{})})
    _lastPickedHandle = dirHandle
    const sid = newSessionId()
    const color = FSID_COLORS[fsidSessions.length % FSID_COLORS.length]
    const s = {
      id: sid, label: dirHandle.name, color, captureInfo: '',
      type: 'hsi',
      hsiFiles: {},        // filename.toLowerCase() -> FileSystemFileHandle
      hsiCustomConfig: [], // ['90_DB_X.log', ...]
      hsiMeta: {},         // { sid, hostname, version, kba, runDate }
      hsiConfigData: null, // { databases:[{name,iniHandles}], refHandles:{}, parsedRef:null } from Configuration/
      hsiLcmLogsData: null, // { tools:[{name, flatFiles:[{name,handle}], opFolders:[{name,files:[{name,handle}]}]}] }
      hsiMdFiles: {},       // filename.toLowerCase() -> FileSystemFileHandle for md_* files
      hsiZipFsids: [],      // [{name}] — ZIP files found in FSIDs/ that need extraction
      hsiRootFolders: [],   // [{order,...}] — numbered dirs in HSI root (new format)
      hsiDynFormat: false,  // true when new NN-Group--MM-Tab.md format detected
      hsiDynGroups: [],     // [{order, displayName, name, tabs,...}] — dynamic menu structure
      hsiDirHandle: dirHandle,
      // FSID fields unused but keep shape consistent
      loadedFiles:{}, loadedFolderName: dirHandle.name,
      versionHistoryHandle:null, configFileHandles:[], configRefHandles:{}, configRefData:{},
      telemetryHandle:null, nsHistoryHandles:[], rteDumpHandles:[], rteDumpScannedPaths:[], rteDumpHdbFound:false, crashDumpHandles:[],
      topoData:null
    }
    // Scan temp/ subfolder
    let tempHandle = null
    try{ tempHandle = await dirHandle.getDirectoryHandle('temp') }catch(e){}
    if(!tempHandle){
      // maybe the user selected the temp folder directly
      for await(const [name, handle] of dirHandle.entries()){
        if(handle.kind==='file' && name.endsWith('.log')) s.hsiFiles[name.toLowerCase()] = handle
        if(handle.kind==='file' && name.toLowerCase().startsWith('md_')) s.hsiMdFiles[name.toLowerCase()] = handle
        if(handle.kind==='file' && name.endsWith('.md') && !name.toLowerCase().startsWith('md_')) s.hsiFiles[name.toLowerCase()] = handle
      }
    } else {
      for await(const [name, handle] of tempHandle.entries()){
        if(handle.kind==='file' && name.endsWith('.log')){
          s.hsiFiles[name.toLowerCase()] = handle
          if(name.startsWith('90_') && name !== '99-LOGFILES.log') s.hsiCustomConfig.push(name)
        }
        if(handle.kind==='file' && name.toLowerCase().startsWith('md_')) s.hsiMdFiles[name.toLowerCase()] = handle
        if(handle.kind==='file' && name.endsWith('.md') && !name.toLowerCase().startsWith('md_')){
          s.hsiFiles[name.toLowerCase()] = handle
          if(name.startsWith('90_') && name !== '99-LOGFILES.md') s.hsiCustomConfig.push(name)
        }
      }
    }
    s.hsiCustomConfig.sort()

    // Scan Configuration/ folder (new HSI format: SYSTEMDB/, DB_X/, reference/)
    try{
      const configDir = await dirHandle.getDirectoryHandle('Configuration')
      await _hsiScanConfigFolder(configDir, s, dirHandle)
    }catch(e){}

    // Try to extract SID + hostname + version + KBA + run date from init log
    try{
      const initHandle = hsiResolveFile(s,'00_initialization_overview.log')?.handle
        || s.hsiFiles[Object.keys(s.hsiFiles).find(k => /^\d+-[^-].*--\d+-.*initialization/i.test(k)) || '']
      if(initHandle){
        const f = await initHandle.getFile()
        const txt = await f.text()
        const sidM     = txt.match(/^SID:\s+([A-Z0-9]{3})\s*$/im)
        const verKbaM  = txt.match(/-\s*HANASupportInfo\s*-\s*(.+?)\s*-\s*KBA:\s*(\d+)/i)
        const hostM    = txt.match(/Static Hostname:\s*(\S+)/i)
        const runM     = txt.match(/##\s*Start command at:\s*(\d{4}-\d{2}-\d{2}\s+\d{2}:\d{2}:\d{2})/i)
        s.hsiMeta = {
          sid:     sidM?.[1]  || '',
          hostname:hostM?.[1] || '',
          version: verKbaM?.[1] || '',
          kba:     verKbaM?.[2] || '3218277',
          runDate: runM?.[1]  || ''
        }
        if(s.hsiMeta.sid) s.captureInfo = 'SID: '+s.hsiMeta.sid+(s.hsiMeta.hostname?' · '+s.hsiMeta.hostname:'')
      }
    }catch(e){}

    fsidSessions.push(s)
    activeFsidId = sid

    // ── Scan FSIDs/ subfolder and load each as a child FSID session ──────────
    try{
      const fsidsDir = await dirHandle.getDirectoryHandle('FSIDs')
      for await(const [name, handle] of fsidsDir.entries()){
        if(handle.kind !== 'directory'){
          // Collect ZIP archives for display in the nav (needs manual extraction)
          if(/\.(zip|tar\.gz|tar|gz)$/i.test(name)) s.hsiZipFsids.push({name})
          continue
        }
        // treat each subfolder as an FSID dump
        const childSid = newSessionId()
        const childColor = s.color  // same color as parent HSI
        const cs = {
          id: childSid, label: name, color: childColor, captureInfo: '',
          type: 'fsid', hsiParentId: sid,  // link to parent HSI session
          loadedFiles:{}, loadedFolderName: name,
          versionHistoryHandle:null, configDirHandle:null, _configScanned:false, configFileHandles:[], configRefHandles:{}, configRefData:{},
          telemetryHandle:null, nsHistoryHandles:[], availabilityHandles:[], rteDumpHandles:[], rteDumpScannedPaths:[], rteDumpHdbFound:false, crashDumpHandles:[],
          hostsFileHandle:null, topoData:null, traceExplorerData:null
        }
        for await(const [fname, fh] of handle.entries()){
          if(fh.kind==='file') cs.loadedFiles[fname.toLowerCase()] = fh
        }
        // SYS/global/hdb/versionhistory.csv
        try{
          const sys=await handle.getDirectoryHandle('SYS')
          const global=await sys.getDirectoryHandle('global')
          const hdb=await global.getDirectoryHandle('hdb')
          try{cs.versionHistoryHandle=await hdb.getFileHandle('versionhistory.csv')}catch(e){}
          try{
            const custom=await hdb.getDirectoryHandle('custom')
            cs.configDirHandle=await custom.getDirectoryHandle('config')
          }catch(e){}
          try{
            const exe=await sys.getDirectoryHandle('exe')
            const hdbExe=await exe.getDirectoryHandle('hdb')
            const refConfig=await hdbExe.getDirectoryHandle('config')
            const _rf=new Set()
            try{for await(const[fn,fh]of refConfig.entries()){if(fh.kind==='file'&&fn.endsWith('.ini')){cs.configRefHandles[fn]=fh;_rf.add(fn)}}}catch(e){}
            for(const fn of HANA_INI_FILES){if(!_rf.has(fn)){try{cs.configRefHandles[fn]=await refConfig.getFileHandle(fn)}catch(e){}}}
          }catch(e){}
        }catch(e){}
        try{const etcDir=await handle.getDirectoryHandle('etc');cs.hostsFileHandle=await etcDir.getFileHandle('hosts')}catch(e){}
        cs.telemetryHandle = cs.loadedFiles['telemetrydata.csv']||null
        // nameserver_history + rtedumps
        try{
          for await(const [n1,h1] of handle.entries()){
            if(h1.kind!=='directory'||!/^HDB\d\d$/.test(n1))continue
            for await(const [n2,h2] of h1.entries()){
              if(h2.kind!=='directory')continue
              try{const trace=await h2.getDirectoryHandle('trace');const fh=await trace.getFileHandle('nameserver_history.trc');cs.nsHistoryHandles.push({hostName:n2,handle:fh})}catch(e){}
              try{const trace=await h2.getDirectoryHandle('trace');for await(const[fn,fh]of trace.entries()){if(fh.kind==='file'&&fn.startsWith('system_availability_')&&fn.endsWith('.trc')){cs.availabilityHandles.push({hostName:n2,handle:fh});break}}}catch(e){}
              try{
                const trace=await h2.getDirectoryHandle('trace')
                const tracePath=`${n1}/${n2}/trace`
                let foundHere=false
                for await(const [fname,fh] of trace.entries()){
                  if(fh.kind==='file'&&fname.includes('.rtedump.')){const parsed=parseRteDumpFilename(fname);if(parsed){cs.rteDumpHandles.push({...parsed,handle:fh,scannedPath:tracePath});foundHere=true}}
                  else if(fh.kind==='file'&&fname.includes('.crashdump.')){const parsed=parseCrashDumpFilename(fname);if(parsed)cs.crashDumpHandles.push({...parsed,handle:fh,scannedPath:tracePath})}
                  else if(fh.kind==='directory'&&fname.startsWith('DB_')){const ttp=`${tracePath}/${fname}`;let foundTenant=false;try{for await(const [tf,th] of fh.entries()){if(th.kind==='file'&&tf.includes('.rtedump.')){const parsed=parseRteDumpFilename(tf);if(parsed){cs.rteDumpHandles.push({...parsed,handle:th,tenant:fname.replace(/^DB_/,''),scannedPath:ttp});foundTenant=true}}else if(th.kind==='file'&&tf.includes('.crashdump.')){const parsed=parseCrashDumpFilename(tf);if(parsed)cs.crashDumpHandles.push({...parsed,handle:th,tenant:fname.replace(/^DB_/,''),scannedPath:ttp})}}}catch(e){};if(foundTenant)cs.rteDumpScannedPaths.push(ttp)}
                }
                if(foundHere)cs.rteDumpScannedPaths.push(tracePath)
              }catch(e){}
            }
          }
          cs.nsHistoryHandles.sort((a,b)=>a.hostName.localeCompare(b.hostName))
          cs.availabilityHandles.sort((a,b)=>a.hostName.localeCompare(b.hostName))
          cs.rteDumpScannedPaths=[...new Set(cs.rteDumpScannedPaths)]
          cs.rteDumpHandles.sort((a,b)=>{const h=a.virtualHost.localeCompare(b.virtualHost);if(h!==0)return h;const sv=a.serviceName.localeCompare(b.serviceName);if(sv!==0)return sv;return b.datetime.localeCompare(a.datetime)})
          cs.rteDumpHandles.forEach((d,i)=>d._idx=i)
          cs.crashDumpHandles.sort((a,b)=>{const h=a.virtualHost.localeCompare(b.virtualHost);if(h!==0)return h;const sv=a.serviceName.localeCompare(b.serviceName);if(sv!==0)return sv;return b.datetime.localeCompare(a.datetime)})
          cs.crashDumpHandles.forEach((d,i)=>d._idx=i)
        }catch(e){}
        // capture info from log.txt
        try{const logH=cs.loadedFiles['log.txt'];if(logH){const lf=await logH.getFile();const lt=await lf.text();const wl=lt.split('\n').find(l=>l.trim().startsWith('Writing to file'));if(wl){const m=wl.match(/fullsysteminfodump_[^_]+_[^_]+_(.+?)_(\d{4})_(\d{2})_(\d{2})_(\d{2})_(\d{2})_(\d{2})\.(zip|tar)/);if(m)cs.captureInfo=`captured on ${m[1]} at ${m[2]}-${m[3]}-${m[4]} ${m[5]}:${m[6]}:${m[7]} UTC`}}}catch(e){}
        // trace explorer: server dirs in HDB<instance>
        try{
          for await(const[n1,h1]of handle.entries()){
            if(h1.kind!=='directory'||!/^HDB\d\d$/.test(n1))continue
            const servers=[]
            for await(const[n2,h2]of h1.entries()){if(h2.kind==='directory')servers.push({name:n2,handle:h2})}
            servers.sort((a,b)=>a.name.localeCompare(b.name))
            if(servers.length){cs.traceExplorerData={instanceDir:n1,servers};break}
          }
        }catch(e){}

        fsidSessions.push(cs)
      }
    }catch(e){} // no FSIDs folder — fine

    // Scan lcm-logs/ subfolder
    try{
      const lcmRoot = await dirHandle.getDirectoryHandle('lcm-logs')
      await _hsiScanLcmFolder(lcmRoot, s)
    }catch(e){}

    // Detect & process new dynamic filename format (NN-GroupName--MM-TabName.md)
    if(Object.keys(s.hsiFiles).some(k => /^\d+-[^-].*--\d+-/.test(k))){
      s.hsiDynFormat = true
      for await(const [name, handle] of dirHandle.entries()){
        if(handle.kind !== 'directory') continue
        const tm = name.match(/^(\d+)-(.+?)--(\d+)-(.+)$/)
        if(tm){ s.hsiRootFolders.push({order:parseInt(tm[1]),groupName:tm[2],tabOrder:parseInt(tm[3]),tabName:tm[4],handle,isTabFolder:true,rawName:name}); continue }
        const fm = name.match(/^(\d+)-([^-].*)$/)
        if(fm && !/^(temp|fsids)$/i.test(fm[2]))
          s.hsiRootFolders.push({order:parseInt(fm[1]),folderName:fm[2],handle,isTabFolder:false,rawName:name})
      }
      if(!s.hsiConfigData){
        const cf = s.hsiRootFolders.find(f => !f.isTabFolder && /configuration/i.test(f.folderName))
        if(cf) try{ await _hsiScanConfigFolder(cf.handle, s, dirHandle) }catch(e){}
      }
      if(!s.hsiLcmLogsData){
        const lf = s.hsiRootFolders.find(f => !f.isTabFolder && /lcm/i.test(f.folderName))
        if(lf) try{ await _hsiScanLcmFolder(lf.handle, s) }catch(e){}
      }
      s.hsiDynGroups = _hsiParseDynGroups(s)
    }

    renderNavTree()
    // auto-navigate to first tab
    const firstTab = hsiGetTabList(s)[0]
    if(firstTab) activateHsiTab(sid, firstTab.id, null)
  }catch(err){ if(err.name!=='AbortError') alert('Error loading HSI folder: '+err.message) }
}

function openFolderInExplorer(path){
  if(!path||!window.__TAURI__?.core?.invoke)return
  window.__TAURI__.core.invoke('open_folder',{path}).catch(()=>{})
}

async function reloadHsiSession(sid){
  const s=sess(sid)
  if(!s?.hsiDirHandle) return
  const dirHandle=s.hsiDirHandle
  // Remove session and all child FSIDs
  const toRemove=new Set([sid])
  fsidSessions.filter(x=>x.hsiParentId===sid).forEach(x=>toRemove.add(x.id))
  fsidSessions=fsidSessions.filter(x=>!toRemove.has(x.id))
  activeFsidId=fsidSessions.length?fsidSessions[fsidSessions.length-1].id:null
  ;['panel-topology','panel-versionhistory','panel-configuration','panel-telemetry','panel-nshistory','panel-availability','panel-rtedumps','panel-crashdumps','panel-hosts','panel-traceexplorer','panel-hsi'].forEach(id=>{
    const el=document.getElementById(id);if(el){el.innerHTML='';el.style.display='';el.classList.remove('active')}
  })
  document.getElementById('empty').style.display='none'
  renderNavTree()
  await loadHSIFolder(dirHandle)
}

// Build the ordered tab list for a session
// Resolves .log names to .md if the new HSI format is present
function hsiResolveFile(s, logName){
  const lk = logName.toLowerCase()
  if(s.hsiFiles[lk]) return {handle:s.hsiFiles[lk], resolvedName:logName}
  const mdKey = lk.replace(/\.log$/, '.md')
  if(s.hsiFiles[mdKey]) return {handle:s.hsiFiles[mdKey], resolvedName:logName.replace(/\.log$/i,'.md')}
  return null
}

function hsiGetTabList(s){
  // New dynamic format: NN-GroupName--MM-TabName.md
  if(s.hsiDynFormat && s.hsiDynGroups?.length){
    const tabs = []
    for(const grp of s.hsiDynGroups){
      if(grp.isTopLevel){
        if(grp.type==='dyn-config')
          tabs.push({id:'dynfol-'+grp.name, label:grp.displayName, type:'hsi-config', subfiles:s.hsiConfigData.databases.map(d=>d.name)})
        else if(grp.type==='lcm-logs')
          tabs.push({id:'lcm-logs', label:grp.displayName, type:'lcm-logs'})
        else
          tabs.push({id:'dynfol-'+grp.name, label:grp.displayName, type:'dyn-explorer', handle:grp.handle})
      } else {
        tabs.push({id:'dyngrp-'+grp.name, label:grp.displayName, type:'dyn-group', tabs:grp.tabs})
      }
    }
    return tabs
  }
  const order = [...HSI_ORDER]
  // inject custom config group
  const ccIdx = order.indexOf('GROUP:HANA_Custom_Config')
  const groups = {...HSI_GROUPS_BASE}
  if(s.hsiConfigData) groups['HANA_Custom_Config'] = s.hsiConfigData.databases.map(d=>d.name)
  else if(s.hsiCustomConfig.length) groups['HANA_Custom_Config'] = s.hsiCustomConfig
  else order.splice(ccIdx, 1)

  const tabs = []
  for(const item of order){
    if(item.startsWith('GROUP:')){
      const grpName = item.slice(6)
      if(grpName==='HANA_Custom_Config' && s.hsiConfigData){
        tabs.push({id:'grp-'+grpName, label:grpName, type:'hsi-config', subfiles:s.hsiConfigData.databases.map(d=>d.name)})
      } else {
        const subfiles = (groups[grpName]||[]).filter(f => hsiResolveFile(s, f))
        if(!subfiles.length){
          // backward compat: old HSI merged Initialization+Overview into one file
          if(grpName==='START' && hsiResolveFile(s,'00_initialization_overview.log'))
            tabs.push({id:'file-00_Initialization_Overview.log', label:'START', type:'file', file:hsiResolveFile(s,'00_initialization_overview.log').resolvedName})
          continue
        }
        tabs.push({id:'grp-'+grpName, label:grpName, type:'group', subfiles})
      }
    } else {
      if(!hsiResolveFile(s, item)) continue
      const clean = item.replace(/^[\d]+_/,'').replace(/\.(log|md)$/i,'')
      tabs.push({id:'file-'+item, label:clean, type:'file', file:item})
    }
  }
  if(s.hsiLcmLogsData && s.hsiLcmLogsData.tools.length)
    tabs.push({id:'lcm-logs', label:'LCM Logs', type:'lcm-logs'})
  // Markdown files (md_*) — appended after Warning_Overview
  const mdKeys = Object.keys(s.hsiMdFiles||{}).sort()
  for(const fname of mdKeys){
    tabs.push({id:'md-'+fname, label:fname.replace(/\.[^.]+$/,''), type:'md-file', file:fname})
  }
  return tabs
}

// Build nav group for an HSI session
function buildHsiNavGroup(s){
  const tabs = hsiGetTabList(s)
  const grp = document.createElement('div')
  grp.className = 'fsid-group open'
  grp.dataset.sid = s.id

  const hdr = document.createElement('div')
  hdr.className = 'fsid-group-header'
  hdr.style.borderLeftColor = s.color
  hdr.innerHTML = `<span class="fsid-group-arrow">▶</span><span class="fsid-group-label" title="${escHtml(s.label)}">&#128202; ${escHtml(s.label)}<span class="fsid-group-subtitle">${escHtml(s.captureInfo)}</span></span>`
  hdr.onclick = () => { grp.classList.toggle('open'); hdr.classList.toggle('active-group', grp.classList.contains('open')) }
  hdr.oncontextmenu = (e) => { e.preventDefault(); showFsidCtxMenu(s.id, e.clientX, e.clientY) }
  grp.appendChild(hdr)

  const children = document.createElement('div')
  children.className = 'fsid-group-children'
  for(const tab of tabs){
    const sub = document.createElement('div')
    sub.className = 'fsid-sub-item'
    sub.dataset.hsiTab = tab.id
    sub.innerHTML = `<span style="font-size:11px;">📄</span>${escHtml(tab.label)}`
    sub.onclick = () => activateHsiTab(s.id, tab.id, null)
    children.appendChild(sub)
  }

  // ── Child FSID sessions (from FSIDs/ subfolder) ──────────────────────────
  const childFsids = fsidSessions.filter(cs => cs.hsiParentId === s.id)
  const zipFsids = s.hsiZipFsids || []
  if(childFsids.length || zipFsids.length){
    const sep = document.createElement('div')
    sep.style.cssText = 'margin:4px 10px 2px 10px;border-top:1px solid #EDEBE9;font-size:10px;font-weight:600;color:#A19F9D;text-transform:uppercase;letter-spacing:0.5px;padding-top:4px;'
    sep.textContent = 'FSIDs'
    children.appendChild(sep)
    for(const cs of childFsids){
      // mini accordion for each child FSID
      const childGrp = document.createElement('div')
      childGrp.className = 'fsid-group open'
      childGrp.dataset.sid = cs.id
      childGrp.style.borderBottom = 'none'

      const childHdr = document.createElement('div')
      childHdr.className = 'fsid-group-header'
      childHdr.style.cssText = `border-left-color:${cs.color};padding-left:20px;font-size:11px;`
      childHdr.innerHTML = `<span class="fsid-group-arrow">▶</span><span class="fsid-group-label" title="${escHtml(cs.label)}">📁 ${escHtml(cs.label)}<span class="fsid-group-subtitle">${escHtml(cs.captureInfo)}</span></span>`
      childHdr.onclick = (e) => { e.stopPropagation(); childGrp.classList.toggle('open') }
      childHdr.oncontextmenu = (e) => { e.preventDefault(); e.stopPropagation(); showFsidCtxMenu(cs.id, e.clientX, e.clientY) }
      childGrp.appendChild(childHdr)

      const childChildren = document.createElement('div')
      childChildren.className = 'fsid-group-children'
      const hasTopology = cs.topoData!=null||'topology.txt' in cs.loadedFiles
      const fsidItems = [
        ...(hasTopology?[{icon:'🗺️', label:'Topology', panel:'topology', disabled:false}]:[]),
        ...(cs.versionHistoryHandle ? [{icon:'📋', label:'Version History', panel:'versionhistory', disabled:false}] : []),
        {icon:'⚙️', label:'Configuration', panel:'configuration', disabled:false},
        ...(cs.hostsFileHandle ? [{icon:'🌐', label:'HOSTS', panel:'hosts', disabled:false}] : []),
        ...(cs.telemetryHandle ? [{icon:'📡', label:'Telemetry Data', panel:'telemetry', disabled:false}] : []),
        ...(cs.nsHistoryHandles?.length ? [{icon:'📈', label:'Nameserver History', panel:'nshistory', disabled:false}] : []),
        ...(cs.availabilityHandles?.length ? [{icon:'🟢', label:'Availability', panel:'availability', disabled:false}] : []),
        {icon:'💥', label:`Runtime Dumps (${cs.rteDumpHandles?.length||0})`, panel:'rtedumps', disabled:false},
        ...(cs.crashDumpHandles?.length?[{icon:'🛑', label:`Crash Dumps (${cs.crashDumpHandles.length})`, panel:'crashdumps', disabled:false}]:[]),
        {icon:'📂', label:'Trace Explorer', panel:'traceexplorer', disabled:false},
      ]
      for(const it of fsidItems){
        const sub = document.createElement('div')
        sub.className = 'fsid-sub-item' + (it.disabled ? ' disabled' : '')
        sub.dataset.panel = it.panel
        sub.style.paddingLeft = '36px'
        sub.innerHTML = `<span style="font-size:12px;">${it.icon}</span>${it.label}`
        if(!it.disabled) sub.onclick = () => activateNavItem(cs.id, it.panel)
        childChildren.appendChild(sub)
      }
      childGrp.appendChild(childChildren)
      children.appendChild(childGrp)
    }
    // ZIP files that still need extraction
    for(const z of zipFsids){
      const zipItem = document.createElement('div')
      zipItem.className = 'fsid-sub-item'
      zipItem.style.paddingLeft = '20px'
      zipItem.innerHTML = `<span style="font-size:12px;">🗜️</span><span style="color:#A19F9D;">${escHtml(z.name)}</span>`
      zipItem.onclick = () => showFsidZipInfo(z.name, s.label, s.id, s.hsiDirHandle?._path)
      children.appendChild(zipItem)
    }
  }

  grp.appendChild(children)
  return grp
}

// Activate an HSI tab (and optional subtab)
async function activateHsiTab(sid, tabId, subTabFile){
  activeFsidId = sid
  activePanel = 'hsi'
  const _s = sess(sid)
  if(_s){ _s._hsiLastTabId = tabId; _s._hsiLastSubTabId = subTabFile }

  // Highlight nav item
  document.getElementById('navTreeBody').querySelectorAll('.fsid-sub-item').forEach(i=>i.classList.remove('active'))
  const grp = document.getElementById('navTreeBody').querySelector(`.fsid-group[data-sid="${sid}"]`)
  if(grp){
    const sub = grp.querySelector(`[data-hsi-tab="${tabId}"]`)
    if(sub){ sub.classList.add('active'); sub.style.borderLeftColor = fsidSessions.find(s=>s.id===sid)?.color||'#107C10' }
    if(!grp.classList.contains('open')) grp.classList.add('open')
  }

  // Show HSI panel, hide others
  document.getElementById('empty').style.display = 'none'
  document.querySelectorAll('.content-panel').forEach(p=>{
    p.classList.remove('active')
    p.style.display = ''
  })
  const panel = document.getElementById('panel-hsi')
  panel.classList.add('active')
  panel.style.display = 'flex'

  const s = sess(sid)
  if(!s) return
  const tabs = hsiGetTabList(s)
  const tab = tabs.find(t=>t.id===tabId)
  if(!tab) return

  panel.innerHTML = ''

  // ── LCM Logs panel ────────────────────────────────────────────────────────
  if(tab.type==='lcm-logs'){
    lcmRenderPanel(panel, s, sid, tabId, subTabFile)
    return
  }

  // ── Folder explorer (new dynamic format) ─────────────────────────────────
  if(tab.type==='dyn-explorer'){
    hsiRenderExplorer(panel, s, tab)
    return
  }

  // ── Dynamic group (NN-Group--MM-Tab format) ───────────────────────────────
  if(tab.type==='dyn-group'){
    const activeTab = tab.tabs.find(t => t.id === subTabFile) || tab.tabs[0]
    const stBar = document.createElement('div')
    stBar.className = 'hsi-subtab-bar'
    tab.tabs.forEach(dt => {
      const btn = document.createElement('button')
      btn.className = 'hsi-subtab-btn' + (dt.id === activeTab.id ? ' active' : '')
      btn.textContent = dt.label
      btn.onclick = () => activateHsiTab(sid, tabId, dt.id)
      stBar.appendChild(btn)
    })
    panel.appendChild(stBar)
    const contentArea = document.createElement('div')
    contentArea.className = 'hsi-content-area'
    panel.appendChild(contentArea)
    await _hsiRenderDynTab(contentArea, activeTab, s)
    return
  }

  // ── Subtab bar (for groups and hsi-config) ───────────────────────────────
  let activeSubFile = subTabFile
  if(tab.type==='group' || tab.type==='hsi-config'){
    const stBar = document.createElement('div')
    stBar.className = 'hsi-subtab-bar'
    if(!activeSubFile) activeSubFile = tab.subfiles[0]
    tab.subfiles.forEach(sf=>{
      const clean = tab.type==='hsi-config' ? sf : sf.replace(/^[\d]+_/,'').replace(/\.(log|md)$/i,'')
      const btn = document.createElement('button')
      btn.className = 'hsi-subtab-btn' + (sf===activeSubFile ? ' active' : '')
      btn.textContent = clean
      btn.onclick = () => activateHsiTab(sid, tabId, sf)
      stBar.appendChild(btn)
    })
    panel.appendChild(stBar)
  }

  // ── Content area ──────────────────────────────────────────────────────────
  const contentArea = document.createElement('div')
  contentArea.className = 'hsi-content-area'
  panel.appendChild(contentArea)

  // ── New format: hsi-config — render INI files with Pure/Explained toggle ──
  if(tab.type==='hsi-config'){
    const dbName = activeSubFile
    const db = s.hsiConfigData.databases.find(d=>d.name===dbName)
    if(!db){ contentArea.innerHTML = `<div class="not-found-msg"><span class="nf-icon">⚠️</span><span>Database folder <code>${escHtml(dbName||'')}</code> not found.</span></div>`; return }
    contentArea.innerHTML = '<div style="color:#A19F9D;font-size:12px;padding:8px;">Loading…</div>'
    // Parse reference data once, then cache in hsiConfigData.parsedRef
    if(!s.hsiConfigData.parsedRef){
      const pr={}
      for(const [name,handle] of Object.entries(s.hsiConfigData.refHandles||{})){
        try{const f=await handle.getFile();pr[name]=parseRefIni(await f.text())}catch(e){}
      }
      if(Object.keys(pr).length===0&&typeof BUNDLED_CONFIG_INI!=='undefined'){
        for(const [name,text] of Object.entries(BUNDLED_CONFIG_INI)){
          pr[name]=parseRefIni(text)
        }
      }
      s.hsiConfigData.parsedRef=pr
    }
    s.configRefData = s.hsiConfigData.parsedRef
    const hasRef = Object.keys(s.hsiConfigData.parsedRef).length > 0
    if(!s.configViewMode) s.configViewMode='explained'
    const mode = s.configViewMode
    const btnStyle=(active)=>`padding:5px 14px;border:none;background:${active?'#0078D4':'#fff'};color:${active?'#fff':'#323130'};cursor:pointer;font-family:inherit;font-size:12px;`
    const parts=[]
    parts.push(`<div style="margin-bottom:14px;display:flex;align-items:center;gap:10px;flex-wrap:wrap;">
    <div style="display:flex;border:1px solid #EDEBE9;border-radius:2px;overflow:hidden;">
      <button onclick="hsiConfigToggleView('explained','${sid}','${tabId}','${escHtml(dbName)}')" style="${btnStyle(mode==='explained')}">Explained</button>
      <button onclick="hsiConfigToggleView('pure','${sid}','${tabId}','${escHtml(dbName)}')" style="${btnStyle(mode==='pure')}border-left:1px solid #EDEBE9;">Pure</button>
    </div>
    ${mode==='explained'&&hasRef?`<span style="font-size:12px;color:#605E5C;">📚 <a href="https://help.sap.com/docs/SAP_HANA_PLATFORM/009e68bc5f3c440cb31823a3ec4bb95b/4b4d88980622427ab2d6ca8c05448166.html?locale=en-US" target="_blank" style="color:#0078D4;text-decoration:underline;">SAP HANA Parameter Reference</a></span>`:''}
  </div>`)
    parts.push(`<div style="margin-bottom:14px;padding:8px 12px;background:#EFF6FF;border:1px solid #BAD7FF;border-radius:2px;font-size:12px;display:flex;align-items:center;gap:10px;">⚙️ <strong>${escHtml(dbName)}</strong> &nbsp;·&nbsp; ${hasRef?'<span style="color:#107C10;">✓ reference data available</span>':'<span style="color:#A19F9D;">no reference data</span>'}</div>`)
    if(mode==='explained'){
      if(!hasRef){
        parts.push(`<div style="margin:24px 0;padding:20px;background:#F3F2F1;border:1px solid #EDEBE9;border-radius:4px;text-align:center;">
          <div style="color:#605E5C;font-size:13px;margin-bottom:12px;">No reference data available. Select a reference folder to enable the Explained view.</div>
          <button onclick="hsiConfigPickRefFolder('${sid}','${tabId}','${escHtml(dbName)}')" style="padding:7px 16px;background:#0078D4;color:#fff;border:none;border-radius:2px;cursor:pointer;font-family:inherit;font-size:13px;">📁 Load reference folder…</button>
        </div>`)
      } else {
        for(const {name,handle,content} of db.iniHandles){
          try{const text=content!==undefined?content:await (await handle.getFile()).text();parts.push(renderIniFile(name,text))}catch(e){}
        }
      }
    } else {
      for(const {name,handle,content} of db.iniHandles){
        try{
          const text=content!==undefined?content:await (await handle.getFile()).text()
          parts.push(`<div class="card" style="margin-bottom:18px;"><div class="card-title">📄 ${escHtml(name)}</div><div class="card-body" style="padding:0;overflow-x:auto;"><pre style="margin:0;padding:10px 12px;font-family:Consolas,monospace;font-size:11px;line-height:1.4;white-space:pre;color:#323130;">${escHtml(text)}</pre></div></div>`)
        }catch(e){}
      }
    }
    contentArea.innerHTML = parts.join('') || '<div class="not-found-msg"><span class="nf-icon">⚠️</span><span>No .ini files found.</span></div>'
    return
  }

  // ── Markdown file rendering ────────────────────────────────────────────────
  if(tab.type==='md-file'){
    const fileHandle = s.hsiMdFiles?.[tab.file]
    if(!fileHandle){ contentArea.innerHTML = `<div class="not-found-msg"><span class="nf-icon">⚠️</span><span>File <code>${escHtml(tab.file)}</code> not found.</span></div>`; return }
    contentArea.innerHTML = '<div style="color:#A19F9D;font-size:12px;padding:8px;">Loading…</div>'
    try{
      const f = await fileHandle.getFile()
      const txt = await f.text()
      contentArea.innerHTML = `<div class="hsi-md-content">${renderMarkdown(txt)}</div>`
    }catch(e){
      contentArea.innerHTML = `<div class="not-found-msg"><span class="nf-icon">⚠️</span><span>Could not read file: ${escHtml(String(e))}</span></div>`
    }
    return
  }

  // ── .log / .md file rendering ─────────────────────────────────────────────
  const fileToLoad = tab.type==='file' ? tab.file : activeSubFile
  if(!fileToLoad){ contentArea.innerHTML = '<div class="not-found-msg"><span class="nf-icon">⚠️</span><span>No file found.</span></div>'; return }

  const resolved = hsiResolveFile(s, fileToLoad)
  if(!resolved){ contentArea.innerHTML = `<div class="not-found-msg"><span class="nf-icon">⚠️</span><span>File <code>${escHtml(fileToLoad)}</code> not found in temp folder.</span></div>`; return }
  const {handle:fileHandle, resolvedName} = resolved

  contentArea.innerHTML = '<div style="color:#A19F9D;font-size:12px;padding:8px;">Loading…</div>'
  try{
    const f = await fileHandle.getFile()
    const txt = await f.text()
    const isMarkdown = resolvedName.toLowerCase().endsWith('.md')
    const baseName = resolvedName.toLowerCase().replace(/\.(log|md)$/,'')
    if(isMarkdown){
      if(baseName.includes('permissions')){
        await renderMdPermFile(contentArea, txt)
      } else {
        contentArea.innerHTML = `<div class="hsi-md-content">${renderMarkdown(txt)}</div>`
      }
    } else {
      contentArea.innerHTML = renderHsiFile(txt, resolvedName)
      if(typeof BUNDLED_FS_REFERENCE!=='undefined'&&baseName.includes('permissions'))
        applyBundledFsRef(contentArea)
    }
    if(baseName.includes('network_test')){
      const btnWrap=document.createElement('div')
      btnWrap.style.cssText='padding:10px 14px 6px;flex-shrink:0;'
      const btn=document.createElement('button')
      btn.textContent='🤖 Prepare SAP Joule Work Desktop'
      btn.style.cssText='padding:6px 16px;background:#0070C3;color:#fff;border:none;border-radius:3px;font-family:inherit;font-size:12px;font-weight:500;cursor:pointer;'
      btn.onclick=()=>showNetworkJoulePrompt(txt)
      btnWrap.appendChild(btn)
      contentArea.insertBefore(btnWrap,contentArea.firstChild)
    }
  }catch(e){
    const p=fileHandle?._path||''
    const pathHtml=p?`<br><span style="font-size:10px;color:#605E5C;word-break:break-all;">Path: ${escHtml(p)}</span>`:''
    contentArea.innerHTML=`<div class="not-found-msg"><span class="nf-icon">⚠️</span><span>${escHtml(String(e))}${pathHtml}</span></div>`
  }
}

// ─── LCM Logs helpers ────────────────────────────────────────────────────────

let _lcmFileHandles=[]

// ─── Dynamic HSI explorer helpers ────────────────────────────────────────────

let _hsiExplHandles = []
let _hsiRteDirEntries = []  // [{sid, files:[{name,handle}]}] — runtime dump folders detected in explorer

async function hsiLoadRteDumpsFromDir(idx){
  const entry = _hsiRteDirEntries[idx]
  if(!entry) return
  const s = sess(entry.sid)
  if(!s) return
  const existing = new Set(s.rteDumpHandles.map(d=>d.filename))
  let added = 0
  for(const {name, handle} of entry.files){
    if(existing.has(name)) continue
    const parsed = parseRuntimeDumpFilename(name)
    if(!parsed) continue
    s.rteDumpHandles.push({...parsed, handle, scannedPath:'', tenant:'', _idx:0})
    added++
  }
  if(added > 0){
    s.rteDumpHandles.sort((a,b)=>{
      const h=a.virtualHost.localeCompare(b.virtualHost); if(h!==0)return h
      const sv=a.serviceName.localeCompare(b.serviceName); if(sv!==0)return sv
      return b.datetime.localeCompare(a.datetime)
    })
    s.rteDumpHandles.forEach((d,i)=>d._idx=i)
    renderNavTree()
  }
  activeFsidId = entry.sid
  activateNav(null, 'rtedumps')
}

// Inline file viewer — keeps the HSI panel (sub-tab bar) intact
async function _hsiExplOpenInline(contentArea, fileHandle, backFn){
  contentArea.innerHTML = '<div style="color:#A19F9D;font-size:12px;padding:8px;">Loading…</div>'
  try{
    const f = await fileHandle.getFile()
    const txt = await f.text()
    const lines = txt.split('\n')
    const wrapper = document.createElement('div')
    wrapper.style.cssText = 'display:flex;flex-direction:column;height:100%;'
    // Up / breadcrumb bar
    const upBar = document.createElement('div')
    upBar.style.cssText = 'padding:5px 10px;background:#F3F2F1;border-bottom:1px solid #EDEBE9;display:flex;align-items:center;gap:8px;font-size:12px;flex-shrink:0;'
    const upBtn = document.createElement('button')
    upBtn.innerHTML = '&#8593; ..'
    upBtn.title = 'Back to folder'
    upBtn.style.cssText = 'background:#fff;border:1px solid #EDEBE9;border-radius:2px;color:#323130;cursor:pointer;font-size:12px;padding:2px 8px;'
    upBtn.onclick = backFn
    upBar.appendChild(upBtn)
    const nameSpan = document.createElement('span')
    nameSpan.textContent = fileHandle.name
    nameSpan.style.cssText = 'color:#605E5C;font-family:Consolas,monospace;font-size:11px;'
    upBar.appendChild(nameSpan)
    const copyBtn = document.createElement('button')
    copyBtn.title = 'Copy all'
    copyBtn.innerHTML = '&#128203;'
    copyBtn.style.cssText = 'margin-left:auto;background:none;border:none;cursor:pointer;font-size:14px;padding:0 4px;color:#605E5C;'
    copyBtn.onclick = () => navigator.clipboard?.writeText(txt).catch(()=>{})
    upBar.appendChild(copyBtn)
    wrapper.appendChild(upBar)
    // Filter bar
    const filterBar = document.createElement('div')
    filterBar.style.cssText = 'padding:4px 10px;background:#F8F8F8;border-bottom:1px solid #EDEBE9;display:flex;align-items:center;gap:6px;flex-shrink:0;'
    const filterInput = document.createElement('input')
    filterInput.type = 'text'
    filterInput.placeholder = 'Filter lines…'
    filterInput.className = 'trace-filter-input'
    filterInput.style.cssText = 'flex:1;padding:3px 8px;border:1px solid #C8C6C4;border-radius:2px;font-size:12px;font-family:inherit;'
    const countSpan = document.createElement('span')
    countSpan.style.cssText = 'color:#A19F9D;font-size:11px;white-space:nowrap;'
    countSpan.textContent = lines.length + ' lines loaded'
    filterBar.appendChild(filterInput)
    filterBar.appendChild(countSpan)
    wrapper.appendChild(filterBar)
    // Line list
    const traceList = document.createElement('div')
    traceList.className = 'trace-list'
    traceList.style.cssText = 'flex:1;overflow-y:auto;'
    function renderLines(filter){
      const lc = filter.toLowerCase()
      let shown = 0
      traceList.innerHTML = ''
      lines.forEach((line, i) => {
        if(filter && !line.toLowerCase().includes(lc)) return
        shown++
        const row = document.createElement('div')
        row.className = 'trace-line'
        row.innerHTML = `<span class="trace-ln">${i+1}</span><span class="trace-text">${escHtml(line)}</span>`
        traceList.appendChild(row)
      })
      countSpan.textContent = filter ? `${shown} / ${lines.length} lines` : `${lines.length} lines loaded`
    }
    filterInput.oninput = () => renderLines(filterInput.value)
    renderLines('')
    wrapper.appendChild(traceList)
    contentArea.innerHTML = ''
    contentArea.appendChild(wrapper)
  }catch(e){
    contentArea.innerHTML = `<div class="not-found-msg"><span class="nf-icon">⚠️</span><span>Could not read file: ${escHtml(String(e))}</span></div>`
  }
}

async function _hsiRenderDynTab(contentArea, dynTab, s){
  if(dynTab.type === 'dyn-explorer') return hsiRenderExplorerContent(contentArea, dynTab.handle, s.id)
  if(dynTab.type === 'dyn-config') return _hsiRenderIniViewerTab(contentArea, s)
  const handle = dynTab.handle
  if(!handle){ contentArea.innerHTML=`<div class="not-found-msg"><span class="nf-icon">⚠️</span><span>File not found.</span></div>`; return }
  contentArea.innerHTML='<div style="color:#A19F9D;font-size:12px;padding:8px;">Loading…</div>'
  try{
    const f = await handle.getFile()
    const txt = await f.text()
    if(dynTab.type === 'dyn-perm') await renderMdPermFile(contentArea, txt)
    else contentArea.innerHTML = `<div class="hsi-md-content">${renderMarkdown(txt)}</div>`
    const fname=(dynTab.file||handle.name||'').toLowerCase()
    if(fname.includes('network_test')){
      const btnWrap=document.createElement('div')
      btnWrap.style.cssText='padding:10px 14px 6px;flex-shrink:0;'
      const btn=document.createElement('button')
      btn.textContent='🤖 Prepare SAP Joule Work Desktop'
      btn.style.cssText='padding:6px 16px;background:#0070C3;color:#fff;border:none;border-radius:3px;font-family:inherit;font-size:12px;font-weight:500;cursor:pointer;'
      btn.onclick=()=>showNetworkJoulePrompt(txt)
      btnWrap.appendChild(btn)
      contentArea.insertBefore(btnWrap,contentArea.firstChild)
    }
  }catch(e){
    contentArea.innerHTML=`<div class="not-found-msg"><span class="nf-icon">⚠️</span><span>Error: ${escHtml(String(e))}</span></div>`
  }
}

async function _hsiRenderIniViewerTab(contentArea, s){
  if(!s.hsiConfigData?.databases?.length){
    contentArea.innerHTML=`<div class="not-found-msg"><span class="nf-icon">⚠️</span><span>No HANA Configuration data found.</span></div>`; return
  }
  if(!s.hsiConfigData.parsedRef){
    const pr={}
    for(const [name,handle] of Object.entries(s.hsiConfigData.refHandles||{})){
      try{const f=await handle.getFile();pr[name]=parseRefIni(await f.text())}catch(e){}
    }
    if(!Object.keys(pr).length&&typeof BUNDLED_CONFIG_INI!=='undefined'){
      for(const [name,text] of Object.entries(BUNDLED_CONFIG_INI)) pr[name]=parseRefIni(text)
    }
    s.hsiConfigData.parsedRef=pr
  }
  s.configRefData=s.hsiConfigData.parsedRef
  const hasRef=Object.keys(s.hsiConfigData.parsedRef||{}).length>0
  if(!s.configViewMode) s.configViewMode='explained'
  contentArea.innerHTML='<div style="color:#A19F9D;font-size:12px;padding:8px;">Loading…</div>'
  const parts=[]
  for(const db of s.hsiConfigData.databases){
    parts.push(`<div style="margin-bottom:10px;padding:8px 12px;background:#EFF6FF;border:1px solid #BAD7FF;border-radius:2px;font-size:12px;"><strong>⚙️ ${escHtml(db.name)}</strong></div>`)
    if(hasRef&&s.configViewMode==='explained'){
      for(const {name,handle,content} of db.iniHandles){
        try{const text=content!==undefined?content:await(await handle.getFile()).text();parts.push(renderIniFile(name,text))}catch(e){}
      }
    } else {
      for(const {name,handle,content} of db.iniHandles){
        try{
          const text=content!==undefined?content:await(await handle.getFile()).text()
          parts.push(`<div class="card" style="margin-bottom:18px;"><div class="card-title">📄 ${escHtml(name)}</div><div class="card-body" style="padding:0;overflow-x:auto;"><pre style="margin:0;padding:10px 12px;font-family:Consolas,monospace;font-size:11px;line-height:1.4;white-space:pre;color:#323130;">${escHtml(text)}</pre></div></div>`)
        }catch(e){}
      }
    }
  }
  contentArea.innerHTML=parts.join('')||'<div class="not-found-msg"><span class="nf-icon">⚠️</span><span>No .ini files found.</span></div>'
}

function hsiRenderExplorer(panel, s, tab){
  const contentArea = document.createElement('div')
  contentArea.className = 'hsi-content-area'
  panel.appendChild(contentArea)
  hsiRenderExplorerContent(contentArea, tab.handle, s.id)
}

// ══════════════════════════════════════════════════════════════════════════
// SAR (System Activity Reporter) viewer
// ══════════════════════════════════════════════════════════════════════════

const _SAR_PALETTE=['#0078D4','#107C10','#D83B01','#8764B8','#038387','#D47500','#A4262C','#B146C2','#00B7C3','#004E8C','#881798','#69797E']
const _sarState={}  // cid → {chart, visibleMetrics, parsedData, cid}

function _sarParseFile(txt){
  const lines=txt.replace(/\r\n/g,'\n').replace(/\r/g,'\n').split('\n')
  let fileDate=null, curHeaders=null, hasCpuCol=false
  const globalRestarts=[], sections=[]
  let curTs=[], curRows=[]
  const flushSection=()=>{
    if(curHeaders&&curRows.length) sections.push({headers:curHeaders,timestamps:[...curTs],rows:[...curRows],hasCpu:hasCpuCol})
    curTs=[]; curRows=[]
  }
  for(const line of lines){
    const t=line.trim(); if(!t) continue
    if(t.startsWith('Linux')){
      const dm=t.match(/\b(\d{2})\/(\d{2})\/(\d{2})\b/)
      if(dm) fileDate=`20${dm[3]}-${dm[1]}-${dm[2]}`
      continue
    }
    const rm=t.match(/^(\d{2}:\d{2}:\d{2})\s+LINUX RESTART/)
    if(rm){ if(fileDate) globalRestarts.push(_sarTimeToMs(fileDate,rm[1])); continue }
    if(/^Average:/.test(t)) continue
    const lm=t.match(/^(\d{2}:\d{2}:\d{2})\s+(.+)$/)
    if(!lm) continue
    const [,timeStr,rest]=lm
    const parts=rest.trim().split(/\s+/)
    if(!/^(all|\d)/.test(parts[0])){
      flushSection()
      curHeaders=[...parts]; hasCpuCol=curHeaders[0]==='CPU'
      if(hasCpuCol) curHeaders=curHeaders.slice(1)
      continue
    }
    if(!curHeaders||!fileDate) continue
    const ms=_sarTimeToMs(fileDate,timeStr)
    if(hasCpuCol){
      if(parts[0]!=='all') continue
      curTs.push(ms); curRows.push(parts.slice(1).map(v=>parseFloat(v)))
    } else {
      curTs.push(ms); curRows.push(parts.map(v=>parseFloat(v)))
    }
  }
  flushSection()
  // Pick best section: prefer CPU (hasCpu flag), else largest by row count
  let best=sections.find(s=>s.hasCpu)
  if(!best) best=sections.reduce((a,b)=>(!a||b.rows.length>a.rows.length)?b:a, null)
  if(!best) return{headers:[],timestamps:[],values:[],restarts:globalRestarts,fileDate}
  const nM=best.headers.length
  const values=Array.from({length:nM},(_,mi)=>best.rows.map(r=>r[mi]??NaN))
  return{headers:best.headers, timestamps:best.timestamps, values, restarts:globalRestarts, fileDate}
}

function _sarTimeToMs(dateStr,timeStr){
  return new Date(`${dateStr}T${timeStr}`).getTime()
}

function _sarDiaryLabel(filename){
  const m=filename.match(/sar?(\d{4})(\d{2})(\d{2})/)
  if(!m) return filename
  const MONTHS=['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec']
  return`${MONTHS[parseInt(m[2])-1]} ${m[3]}, ${m[1]}`
}

async function sarRenderFolder(container, dirHandle, sid){
  const items=[]
  for await(const [name,handle] of dirHandle.entries())
    if(handle.kind==='file') items.push({name,handle})
  const diaryItems=items.filter(i=>/^sar?\d{8}\.txt$/i.test(i.name)).sort((a,b)=>a.name.localeCompare(b.name))
  const liveU=items.find(i=>i.name.toLowerCase()==='sar_live_u.txt')
  const liveB=items.find(i=>i.name.toLowerCase()==='sar_live_b.txt')
  const liveQ=items.find(i=>i.name.toLowerCase()==='sar_live_q.txt')
  const hasLive=!!(liveU||liveB||liveQ)
  if(!hasLive&&!diaryItems.length) return false

  const cid='sar-'+sid+'-'+dirHandle.name.replace(/[^a-z0-9]/gi,'-').toLowerCase()
  if(!_sarState[cid]) _sarState[cid]={chart:null, visibleMetrics:new Set(), parsedData:null, cid}
  const st=_sarState[cid]

  // Build outer tab bar (Live | Diary dates)
  const outerTabs=[]
  if(hasLive) outerTabs.push({id:'live', label:'📊 Live'})
  diaryItems.forEach(di=>outerTabs.push({id:'diary-'+di.name, label:`📅 ${_sarDiaryLabel(di.name)}`, handle:di.handle}))

  container.style.cssText='padding:0;overflow:hidden;display:flex;flex-direction:column;height:100%;'
  container.innerHTML=''
  const tabBar=document.createElement('div')
  tabBar.style.cssText='display:flex;border-bottom:1px solid #EDEBE9;background:#F3F2F1;padding:0 12px;overflow-x:auto;white-space:nowrap;flex-shrink:0;'
  container.appendChild(tabBar)
  const body=document.createElement('div')
  body.style.cssText='flex:1;min-height:0;display:flex;flex-direction:column;overflow:hidden;'
  container.appendChild(body)

  const switchOuter=async(tabId)=>{
    tabBar.querySelectorAll('button').forEach(b=>{
      const a=b.dataset.tabId===tabId
      b.style.color=a?'#0078D4':'#605E5C'; b.style.borderBottom=a?'2px solid #0078D4':'2px solid transparent'
      b.style.fontWeight=a?'600':'normal'; b.style.background=a?'#EFF6FC':'transparent'
    })
    body.innerHTML='<div style="color:#A19F9D;font-size:12px;padding:12px;">Loading…</div>'
    if(tabId==='live'){
      await _sarRenderLive(body,{u:liveU,b:liveB,q:liveQ},cid)
    } else {
      const tab=outerTabs.find(t=>t.id===tabId)
      if(tab?.handle){
        try{
          const f=await tab.handle.getFile(); const txt=await f.text()
          const parsed=_sarParseFile(txt)
          _sarBuildView(body, parsed, cid, _sarDiaryLabel(tab.handle.name))
        }catch(e){ body.innerHTML=`<div class="not-found-msg"><span class="nf-icon">⚠️</span><span>Error: ${escHtml(String(e))}</span></div>` }
      }
    }
  }
  outerTabs.forEach(tab=>{
    const btn=document.createElement('button')
    btn.dataset.tabId=tab.id
    btn.style.cssText='display:inline-flex;align-items:center;height:36px;padding:0 14px;border:none;border-bottom:2px solid transparent;background:transparent;font-family:inherit;font-size:12px;color:#605E5C;cursor:pointer;white-space:nowrap;'
    btn.textContent=tab.label; btn.onclick=()=>switchOuter(tab.id); tabBar.appendChild(btn)
  })
  switchOuter(outerTabs[0].id)
  return true
}

async function _sarRenderLive(body, liveItems, cid){
  const subTabs=[]
  if(liveItems.u) subTabs.push({id:'cpu',  label:'CPU',      handle:liveItems.u.handle})
  if(liveItems.b) subTabs.push({id:'block',label:'Block I/O', handle:liveItems.b.handle})
  if(liveItems.q) subTabs.push({id:'queue',label:'Queue/Load',handle:liveItems.q.handle})
  if(!subTabs.length){ body.innerHTML='<div class="not-found-msg"><span class="nf-icon">⚠️</span><span>No live SAR files found.</span></div>'; return }
  if(subTabs.length===1){
    try{
      const f=await subTabs[0].handle.getFile(); const txt=await f.text()
      _sarBuildView(body, _sarParseFile(txt), cid, 'Live — '+subTabs[0].label)
    }catch(e){ body.innerHTML=`<div class="not-found-msg"><span class="nf-icon">⚠️</span><span>Error: ${escHtml(String(e))}</span></div>` }
    return
  }
  // Multiple sub-tabs
  const subBar=document.createElement('div')
  subBar.style.cssText='display:flex;gap:2px;padding:6px 12px 0;background:#F8F8F7;border-bottom:1px solid #EDEBE9;flex-shrink:0;'
  body.innerHTML=''; body.appendChild(subBar)
  const subContent=document.createElement('div')
  subContent.style.cssText='flex:1;min-height:0;display:flex;flex-direction:column;overflow:hidden;'
  body.appendChild(subContent)

  const switchSub=async(tabId)=>{
    subBar.querySelectorAll('button').forEach(b=>{
      const a=b.dataset.tabId===tabId
      b.style.background=a?'#fff':'#e9ecef'; b.style.fontWeight=a?'700':'normal'
      b.style.color=a?'#0d6efd':'#495057'; b.style.borderBottomColor=a?'#0d6efd':'transparent'
    })
    subContent.innerHTML='<div style="color:#A19F9D;font-size:12px;padding:12px;">Loading…</div>'
    const tab=subTabs.find(t=>t.id===tabId); if(!tab) return
    try{
      const f=await tab.handle.getFile(); const txt=await f.text()
      _sarBuildView(subContent, _sarParseFile(txt), cid+'-'+tabId, `Live — ${tab.label}`)
    }catch(e){ subContent.innerHTML=`<div class="not-found-msg"><span class="nf-icon">⚠️</span><span>Error: ${escHtml(String(e))}</span></div>` }
  }
  subTabs.forEach(tab=>{
    const btn=document.createElement('button')
    btn.dataset.tabId=tab.id
    btn.style.cssText='display:inline-flex;align-items:center;height:28px;padding:0 14px;border:1px solid #dee2e6;border-bottom:none;border-radius:6px 6px 0 0;background:#e9ecef;font-family:inherit;font-size:11px;color:#495057;cursor:pointer;white-space:nowrap;'
    btn.textContent=tab.label; btn.onclick=()=>switchSub(tab.id); subBar.appendChild(btn)
  })
  switchSub(subTabs[0].id)
}

function _sarBuildView(wrapper, parsed, cid, title){
  if(!_sarState[cid]) _sarState[cid]={chart:null, visibleMetrics:new Set(), parsedData:null, cid}
  const st=_sarState[cid]
  if(st.chart){st.chart.destroy();st.chart=null}
  st.parsedData=parsed

  // Default visible metrics
  const CPU_VIS=new Set(['%user','%usr','%system','%sys','%iowait'])
  const IO_VIS=new Set(['tps','bwrtn/s','bread/s'])
  const Q_VIS=new Set(['ldavg-1','ldavg-5','ldavg-15','runq-sz'])
  st.visibleMetrics=new Set(parsed.headers.filter(h=>CPU_VIS.has(h)||IO_VIS.has(h)||Q_VIS.has(h)))
  if(!st.visibleMetrics.size) parsed.headers.slice(0,4).forEach(h=>st.visibleMetrics.add(h))

  wrapper.innerHTML=''
  // info bar
  const infoBar=document.createElement('div')
  infoBar.style.cssText='flex-shrink:0;padding:3px 12px;font-size:10px;color:#605E5C;background:#FAFAF9;border-bottom:1px solid #EDEBE9;display:flex;align-items:center;justify-content:space-between;'
  infoBar.innerHTML=`<span><strong>📊 ${escHtml(title)}</strong> &nbsp;·&nbsp; ${parsed.timestamps.length.toLocaleString()} data points${parsed.restarts.length?` &nbsp;·&nbsp; <span style="color:#D83B01;">⚡ ${parsed.restarts.length} restart${parsed.restarts.length>1?'s':''}</span>`:''}</span><span id="${cid}-pts" style="color:#A19F9D;"></span>`
  wrapper.appendChild(infoBar)

  // Main body: chart + param panel
  const mainDiv=document.createElement('div')
  mainDiv.style.cssText='flex:1;min-height:0;display:flex;overflow:hidden;'
  wrapper.appendChild(mainDiv)
  const chartArea=document.createElement('div')
  chartArea.style.cssText='flex:1;min-width:0;position:relative;'
  mainDiv.appendChild(chartArea)
  const canvas=document.createElement('canvas')
  canvas.id=cid+'-canvas'
  canvas.style.cssText='position:absolute;top:8px;left:8px;right:8px;bottom:8px;width:calc(100% - 16px) !important;height:calc(100% - 16px) !important;'
  chartArea.appendChild(canvas)

  // Param panel
  const panel=document.createElement('div')
  panel.style.cssText='width:200px;flex-shrink:0;border-left:1px solid #EDEBE9;display:flex;flex-direction:column;overflow:hidden;background:#FAFAF9;'
  mainDiv.appendChild(panel)
  const panelHdr=document.createElement('div')
  panelHdr.style.cssText='padding:6px 10px;font-size:10px;font-weight:700;color:#605E5C;background:#F3F2F1;border-bottom:1px solid #EDEBE9;flex-shrink:0;text-transform:uppercase;letter-spacing:0.04em;'
  panelHdr.textContent='Metrics'
  panel.appendChild(panelHdr)
  const panelRows=document.createElement('div')
  panelRows.id=cid+'-param-rows'
  panelRows.style.cssText='flex:1;overflow-y:auto;'
  panel.appendChild(panelRows)
  _sarUpdateParamPanel(cid)

  sarDraw(cid)
}

function _sarUpdateParamPanel(cid){
  const st=_sarState[cid]; if(!st) return
  const el=document.getElementById(cid+'-param-rows'); if(!el) return
  const html=st.parsedData.headers.map((h,mi)=>{
    const color=_SAR_PALETTE[mi%_SAR_PALETTE.length]
    const chk=st.visibleMetrics.has(h)
    return`<div style="display:flex;align-items:center;gap:6px;padding:5px 8px;font-size:11px;cursor:pointer;border-bottom:1px solid #F3F2F1;border-left:3px solid ${chk?color:'transparent'};${chk?'background:#F5F9FF;':''}" onclick="sarToggleMetric(${JSON.stringify(cid)},${JSON.stringify(h)})">
      <span style="width:10px;height:10px;border-radius:50%;background:${chk?color:'#C8C6C4'};flex-shrink:0;"></span>
      <span style="overflow:hidden;text-overflow:ellipsis;white-space:nowrap;flex:1;">${escHtml(h)}</span>
    </div>`
  }).join('')
  el.innerHTML=html
}

function sarToggleMetric(cid, metricName){
  const st=_sarState[cid]; if(!st) return
  if(st.visibleMetrics.has(metricName)) st.visibleMetrics.delete(metricName)
  else st.visibleMetrics.add(metricName)
  _sarUpdateParamPanel(cid)
  sarDraw(cid)
}

function sarDraw(cid){
  const st=_sarState[cid]; if(!st) return
  const canvas=document.getElementById(cid+'-canvas'); if(!canvas) return
  const{parsedData,visibleMetrics}=st
  if(st.chart){st.chart.destroy();st.chart=null}
  const{headers,timestamps,values,restarts}=parsedData
  const MAX=1500
  const datasets=headers.map((h,mi)=>{
    const{xs,ys}=_nscLttb(timestamps,values[mi],MAX)
    return{
      label:h, data:xs.map((x,i)=>({x,y:ys[i]})),
      borderColor:_SAR_PALETTE[mi%_SAR_PALETTE.length],
      backgroundColor:_SAR_PALETTE[mi%_SAR_PALETTE.length]+'18',
      borderWidth:1.5, pointRadius:0, pointHoverRadius:3, tension:0.2,
      hidden:!visibleMetrics.has(h)
    }
  })
  const spanMs=timestamps.length>1?timestamps[timestamps.length-1]-timestamps[0]:0
  const xTickCb=v=>{const d=new Date(v),hh=String(d.getHours()).padStart(2,'0'),mm=String(d.getMinutes()).padStart(2,'0');return spanMs>86400000?`${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')} ${hh}:${mm}`:`${hh}:${mm}`}

  // Determine if this is a % metric group (use fixed 0-100 scale) or free-scale
  const visHdrs=[...visibleMetrics].filter(h=>headers.includes(h))
  const isPct=visHdrs.length>0&&visHdrs.every(h=>/^%|idle$|wait$/i.test(h))
  const scales={x:{type:'linear',ticks:{maxTicksLimit:8,callback:xTickCb,maxRotation:0},grid:{color:'rgba(0,0,0,0.05)'}}}
  headers.forEach((_,mi)=>{
    const h=headers[mi],isPctM=/^%|idle$|wait$/i.test(h)
    const yMax=isPctM?100:undefined
    scales['y-'+mi]={type:'linear',display:false,min:0,max:yMax,suggestedMax:yMax?undefined:undefined,grid:{drawOnChartArea:mi===0,color:'rgba(0,0,0,0.06)'}}
    datasets[mi].yAxisID='y-'+mi
  })

  // Restart annotation plugin
  const restartPlugin={id:'sarRestarts',afterDraw:(chart)=>{
    if(!restarts.length) return
    const ctx=chart.ctx,xScale=chart.scales.x
    ctx.save(); ctx.strokeStyle='#D83B01'; ctx.setLineDash([4,3]); ctx.lineWidth=1.5
    restarts.forEach(ms=>{
      const x=xScale.getPixelForValue(ms)
      if(x<chart.chartArea.left||x>chart.chartArea.right) return
      ctx.beginPath(); ctx.moveTo(x,chart.chartArea.top); ctx.lineTo(x,chart.chartArea.bottom); ctx.stroke()
    })
    ctx.restore()
  }}

  st.chart=new Chart(canvas,{type:'line',data:{datasets},options:{
    responsive:true,maintainAspectRatio:false,animation:false,
    interaction:{intersect:false,mode:'index'},
    plugins:{legend:{display:false},tooltip:{callbacks:{
      title:items=>{const ms=items[0]?.parsed?.x||0;const d=new Date(ms);return`${String(d.getHours()).padStart(2,'0')}:${String(d.getMinutes()).padStart(2,'0')}:${String(d.getSeconds()).padStart(2,'0')}`},
      label:item=>{if(item.dataset.hidden)return null;const v=item.parsed.y;return`${item.dataset.label}: ${typeof v==='number'?v.toLocaleString(undefined,{maximumFractionDigits:2}):'-'}`}
    }}},
    scales
  },plugins:[restartPlugin]})
  const ptsEl=document.getElementById(cid+'-pts')
  if(ptsEl) ptsEl.textContent=`${timestamps.length.toLocaleString()} pts${timestamps.length>MAX?` · LTTB→${MAX}`:''}`
}

async function hsiRenderExplorerContent(container, dirHandle, sid){
  _hsiExplHandles = []
  _hsiRteDirEntries = []
  container.innerHTML = '<div style="color:#A19F9D;font-size:12px;padding:8px;">Loading…</div>'
  try{
    // SAR folder detection — renders chart viewer instead of file list
    if(await sarRenderFolder(container, dirHandle, sid)) return
    const items = []
    for await(const [name, handle] of dirHandle.entries()) items.push({name, handle})
    items.sort((a,b) => {
      const ad=a.handle.kind==='directory', bd=b.handle.kind==='directory'
      if(ad!==bd) return ad?-1:1
      return a.name.localeCompare(b.name)
    })
    if(!items.length){ container.innerHTML='<div class="not-found-msg"><span class="nf-icon">📂</span><span>Empty folder.</span></div>'; return }
    const parts = []
    for(const item of items){
      if(item.handle.kind === 'directory'){
        parts.push(`<div class="lcm-section-hdr">📁 ${escHtml(item.name)}</div>`)
        try{
          const sub=[]
          for await(const [sn,sh] of item.handle.entries()) sub.push({name:sn,handle:sh})
          sub.sort((a,b)=>a.name.localeCompare(b.name))
          // Detect runtimedump .trc files in this subfolder
          const rteDumps = sub.filter(si => si.handle.kind==='file' && /runtimedump/i.test(si.name) && si.name.toLowerCase().endsWith('.trc'))
          if(rteDumps.length){
            const rteIdx = _hsiRteDirEntries.push({sid, files:rteDumps.map(si=>({name:si.name,handle:si.handle}))}) - 1
            parts.push(`<div style="background:#EFF6FC;border:1px solid #BAD7FF;border-radius:4px;padding:8px 12px;margin:4px 0 8px 0;display:flex;align-items:center;gap:12px;flex-wrap:wrap;">
              <span style="font-size:12px;color:#0078D4;font-weight:600;">💥 ${rteDumps.length} runtime dump file${rteDumps.length>1?'s':''} found</span>
              <button onclick="hsiLoadRteDumpsFromDir(${rteIdx})" style="padding:4px 12px;background:#0078D4;color:#fff;border:none;border-radius:2px;cursor:pointer;font-size:11px;font-family:inherit;font-weight:500;white-space:nowrap;">▶ Load in Runtime Dumps viewer</button>
            </div>`)
          }
          for(const si of sub) parts.push(_hsiExplFileRow(si.name, si.handle, item.handle, sid))
        }catch(e){}
      } else {
        parts.push(_hsiExplFileRow(item.name, item.handle, dirHandle, sid))
      }
    }
    container.innerHTML = parts.join('') || '<div class="not-found-msg"><span class="nf-icon">⚠️</span><span>No files.</span></div>'
  }catch(e){
    container.innerHTML=`<div class="not-found-msg"><span class="nf-icon">⚠️</span><span>Error reading folder: ${escHtml(String(e))}</span></div>`
  }
}

function _hsiExplFileRow(name, handle, parentHandle, sid){
  const lname = name.toLowerCase()
  const isXz = lname.endsWith('.xz')
  const isZip = lname.endsWith('.zip')
  if(isXz || isZip){
    const p = parentHandle._path||''
    const label = isZip ? '.zip — extract to browse contents' : '.xz compressed'
    const icon = '🗜️'
    const btn = (p && window.__TAURI__) ? `<button data-path="${escHtml(p)}" onclick="openFolderInExplorer(this.dataset.path)" style="margin-left:auto;padding:2px 8px;background:#0078D4;color:#fff;border:none;border-radius:2px;cursor:pointer;font-size:10px;flex-shrink:0;">📂 Open folder</button>` : ''
    return `<div class="lcm-file-item" style="cursor:default;"><span class="lcm-file-icon">${icon}</span><span style="color:#323130;">${escHtml(name)}</span><span style="font-size:10px;color:#A19F9D;margin-left:6px;">${label}</span>${btn}</div>`
  }
  const idx = _hsiExplHandles.push({handle, name, parentHandle, sid}) - 1
  return `<div class="lcm-file-item" onclick="hsiExplOpenFile(${idx})"><span class="lcm-file-icon">${lcmFileIcon(name)}</span>${escHtml(name)}</div>`
}

async function hsiExplOpenFile(idx){
  const entry = _hsiExplHandles[idx]
  if(!entry) return
  const s = sess(entry.sid)
  if(!s) return
  // Render inline: keep #panel-hsi visible so the sub-tab bar stays
  const panel = document.getElementById('panel-hsi')
  const contentArea = panel?.querySelector('.hsi-content-area')
  if(contentArea){
    const backFn = () => activateHsiTab(entry.sid, s._hsiLastTabId||'', s._hsiLastSubTabId||null)
    await _hsiExplOpenInline(contentArea, entry.handle, backFn)
    return
  }
  // Fallback: trace explorer (only if no panel found)
  s.traceExplorerData = {instanceDir:'hsi-explorer', servers:[{name:'', handle:entry.parentHandle}]}
  s.traceExplState = {
    sid:s.id, serverIdx:0, stack:[], entries:[],
    viewingFile:{name:entry.name, handle:entry.handle, isDir:false, size:null, lastModified:null},
    sortCol:'name', sortDir:'asc', scrollTop:0, serverStates:{}
  }
  activeFsidId = s.id
  activateNav(null, 'traceexplorer')
}

function lcmFileIcon(name){
  const ext=name.split('.').pop().toLowerCase()
  if(ext==='log')return '📋'
  if(ext==='trc')return '📄'
  if(ext==='xml')return '📑'
  if(ext==='cfg')return '⚙️'
  return '📄'
}

function lcmRenderPanel(panel,s,sid,tabId,subTabFile){
  const lcm=s.hsiLcmLogsData
  if(!lcm||!lcm.tools.length){
    const ca=document.createElement('div');ca.className='hsi-content-area'
    ca.innerHTML='<div class="not-found-msg"><span class="nf-icon">⚠️</span><span>No lcm-logs data found.</span></div>'
    panel.appendChild(ca);return
  }
  const stBar=document.createElement('div')
  stBar.className='hsi-subtab-bar'
  const activeTool=subTabFile||lcm.tools[0].name
  lcm.tools.forEach(t=>{
    const btn=document.createElement('button')
    btn.className='hsi-subtab-btn'+(t.name===activeTool?' active':'')
    btn.textContent=t.name
    btn.onclick=()=>activateHsiTab(sid,tabId,t.name)
    stBar.appendChild(btn)
  })
  panel.appendChild(stBar)
  const ca=document.createElement('div');ca.className='hsi-content-area'
  panel.appendChild(ca)
  const tool=lcm.tools.find(t=>t.name===activeTool)
  if(tool) lcmRenderToolView(ca,tool,sid)
}

function lcmRenderToolView(container,tool,sid){
  _lcmFileHandles=[]
  const parts=[]
  if(tool.opFolders.length){
    parts.push('<div class="lcm-section-hdr">Operations</div>')
    tool.opFolders.forEach(op=>{
      const label=op.name
        .replace(/^hdb_[^_]+_/,'')
        .replace(/_(\d{4}-\d{2}-\d{2})_(\d{2})\.(\d{2})\.(\d{2})$/,' · $1 $2:$3')
        .replace(/_/g,' ')
      const fileRows=op.files.map(f=>{
        const idx=_lcmFileHandles.push({handle:f.handle,name:f.name,sid,toolName:tool.name,toolHandle:tool.handle,stackFrame:{name:op.name,handle:op.handle}})-1
        return `<div class="lcm-file-item" onclick="lcmOpenFile(${idx})"><span class="lcm-file-icon">${lcmFileIcon(f.name)}</span>${escHtml(f.name)}</div>`
      }).join('')
      parts.push(`<div class="lcm-op-folder open">
        <div class="lcm-op-header" onclick="this.closest('.lcm-op-folder').classList.toggle('open')"><span class="lcm-op-arrow">▶</span><span>📁 ${escHtml(label)}</span></div>
        <div class="lcm-op-files">${fileRows||'<div style="padding:6px 16px;color:#A19F9D;font-size:11px;">Empty</div>'}</div>
      </div>`)
    })
  }
  if(tool.flatFiles.length){
    parts.push('<div class="lcm-section-hdr">Files</div>')
    tool.flatFiles.forEach(f=>{
      const idx=_lcmFileHandles.push({handle:f.handle,name:f.name,sid,toolName:tool.name,toolHandle:tool.handle,stackFrame:null})-1
      parts.push(`<div class="lcm-file-item" onclick="lcmOpenFile(${idx})"><span class="lcm-file-icon">${lcmFileIcon(f.name)}</span>${escHtml(f.name)}</div>`)
    })
  }
  container.innerHTML=parts.join('')||'<div class="not-found-msg"><span class="nf-icon">⚠️</span><span>No files found.</span></div>'
}

async function lcmOpenFile(idx){
  const entry=_lcmFileHandles[idx]
  if(!entry)return
  const s=sess(entry.sid)
  if(!s)return
  // Render inline: keep #panel-hsi visible so the LCM tool-tab bar stays
  const panel = document.getElementById('panel-hsi')
  const contentArea = panel?.querySelector('.hsi-content-area')
  if(contentArea){
    const backFn = () => activateHsiTab(entry.sid, s._hsiLastTabId||'lcm-logs', s._hsiLastSubTabId||null)
    await _hsiExplOpenInline(contentArea, entry.handle, backFn)
    return
  }
  // Fallback: trace explorer with all LCM tools
  const lcm=s.hsiLcmLogsData
  const toolIdx=lcm?lcm.tools.findIndex(t=>t.name===entry.toolName):0
  s.traceExplorerData={
    instanceDir:'lcm-logs',
    servers:lcm?lcm.tools.map(t=>({name:t.name,handle:t.handle})):[{name:entry.toolName,handle:entry.toolHandle}]
  }
  const stack=entry.stackFrame?[entry.stackFrame]:[]
  s.traceExplState={
    sid:s.id,serverIdx:toolIdx>=0?toolIdx:0,stack,entries:[],
    viewingFile:{name:entry.name,handle:entry.handle,isDir:false,size:null,lastModified:null},
    sortCol:'name',sortDir:'asc',scrollTop:0,serverStates:{}
  }
  activeFsidId=s.id
  activateNav(null,'traceexplorer')
}

function showFsidZipInfo(zipName, hsiLabel, sid, hsiRootPath){
  // Show panel-hsi with an extraction hint for this ZIP
  document.getElementById('empty').style.display = 'none'
  document.querySelectorAll('.content-panel').forEach(p=>{p.classList.remove('active');p.style.display=''})
  const panel = document.getElementById('panel-hsi')
  panel.classList.add('active')
  panel.style.display = 'flex'
  const fsidsPath = hsiRootPath ? hsiRootPath.replace(/\\/g,'/')+ '/FSIDs' : null
  const openBtnHtml = fsidsPath
    ? `<button data-path="${escHtml(fsidsPath)}" onclick="openFolderInExplorer(this.dataset.path)" style="margin-left:8px;padding:8px 20px;background:#0078D4;color:#fff;border:none;border-radius:2px;font-family:inherit;font-size:13px;font-weight:500;cursor:pointer;">📂 Open FSIDs folder</button>`
    : ''
  panel.innerHTML = `<div class="hsi-content-area" style="display:flex;align-items:center;justify-content:center;">
    <div style="max-width:480px;text-align:center;">
      <div style="font-size:40px;margin-bottom:12px;">🗜️</div>
      <div style="font-size:15px;font-weight:600;color:#323130;margin-bottom:10px;">${escHtml(zipName)}</div>
      <div style="font-size:13px;color:#605E5C;line-height:1.6;margin-bottom:18px;">
        This FSID is stored as a ZIP archive and cannot be loaded directly.<br>
        Please extract the archive into the <code style="font-size:11px;background:#F3F2F1;padding:1px 5px;border-radius:2px;">FSIDs/</code> folder of this HSI,
        then reload the HSI using <strong>Load HSI / NETTEST</strong>.
      </div>
      <button onclick="reloadHsiSession('${escHtml(sid)}')" style="padding:8px 20px;background:#107C10;color:#fff;border:none;border-radius:2px;font-family:inherit;font-size:13px;font-weight:500;cursor:pointer;">🔄 Reload HSI</button>${openBtnHtml}
      <div style="margin-top:14px;font-size:11px;color:#A19F9D;">📂 ${escHtml(hsiLabel)} › FSIDs › ${escHtml(zipName)}</div>
    </div>
  </div>`
}

function showNetworkJoulePrompt(rawText){
  const lines=rawText.split('\n')
  let startIdx=-1,endIdx=lines.length
  for(let i=0;i<lines.length;i++){
    if(startIdx===-1&&/^1\.\s*ICMP Ping Baseline/.test(lines[i])) startIdx=i
    if(startIdx!==-1&&(/^Network Test Summary and Evaluation/.test(lines[i])||/^Phase Results Overview/.test(lines[i]))){ endIdx=i; break }
  }
  const extracted=startIdx>=0?lines.slice(startIdx,endIdx).join('\n').trimEnd():rawText

  const prompt=`You are a Senior SAP HANA Support Expert. Analyze the following network test output and assess whether the network is suitable for SAP HANA (e.g. scale-out, HSR, inter-node communication).

Evaluate each of the following areas and provide a concise verdict per section:

ICMP Ping Baseline — latency (avg/max/mdev), packet loss
Jumbo Frames MTU 9000 — end-to-end MTU support, loss under jumbo load
Routing / Traceroute — hop count, L2 vs. routed path
TCP Single-Stream Bandwidth — throughput, retransmits
TCP Bidirectional Bandwidth — throughput per direction, retransmits
TCP Multi-Stream Bandwidth — aggregate throughput, retransmits
UDP Jitter & Loss (100M / 1G / 10G) — jitter values, loss percentage at each load level

Then provide:

A summary table (test | result | verdict)
A detailed analysis section explaining what each result means in the context of HANA requirements (latency thresholds, bandwidth minimums, jumbo frame relevance, TCP retransmit impact on HSR/replication)
A recommendations section — flag anything missing (e.g. switch interface data), reference relevant SAP Notes where applicable, and note any risks or follow-up actions
Overall verdict: clearly state whether the network is fit for HANA and at what tier (minimum / good / excellent).

Respond in English. Be concise and technical.

--- BEGIN NETWORK TEST OUTPUT ---
${extracted}
--- END NETWORK TEST OUTPUT ---`

  document.getElementById('joule-modal')?.remove()
  const overlay=document.createElement('div')
  overlay.id='joule-modal'
  overlay.style.cssText='position:fixed;inset:0;background:rgba(0,0,0,0.5);z-index:9999;display:flex;align-items:center;justify-content:center;padding:24px;box-sizing:border-box;'
  overlay.onclick=e=>{if(e.target===overlay)overlay.remove()}

  const card=document.createElement('div')
  card.style.cssText='background:#fff;border-radius:4px;width:100%;max-width:860px;max-height:90vh;display:flex;flex-direction:column;box-shadow:0 8px 32px rgba(0,0,0,0.28);'

  const hdr=document.createElement('div')
  hdr.style.cssText='padding:12px 16px;border-bottom:1px solid #EDEBE9;display:flex;align-items:center;justify-content:space-between;gap:12px;flex-shrink:0;'
  hdr.innerHTML=`<span style="font-size:13px;font-weight:600;color:#323130;">🤖 SAP Joule Work Desktop — Network Analysis Prompt</span><div style="display:flex;gap:8px;"><button id="joule-copy-btn" style="padding:4px 14px;background:#0078D4;color:#fff;border:none;border-radius:2px;font-family:inherit;font-size:12px;cursor:pointer;">📋 Copy</button><button onclick="document.getElementById('joule-modal').remove()" style="padding:4px 10px;background:#F3F2F1;border:1px solid #EDEBE9;border-radius:2px;font-family:inherit;font-size:12px;cursor:pointer;">✕ Close</button></div>`

  const body=document.createElement('div')
  body.style.cssText='padding:12px 16px;flex:1;overflow:auto;min-height:0;'

  const ta=document.createElement('textarea')
  ta.value=prompt
  ta.readOnly=true
  ta.style.cssText='width:100%;height:100%;min-height:420px;box-sizing:border-box;font-family:Consolas,monospace;font-size:11px;line-height:1.5;border:1px solid #EDEBE9;padding:10px;resize:none;color:#323130;outline:none;'

  body.appendChild(ta)
  card.appendChild(hdr)
  card.appendChild(body)
  overlay.appendChild(card)
  document.body.appendChild(overlay)
  ta.focus(); ta.select()

  document.getElementById('joule-copy-btn').onclick=async()=>{
    try{
      await navigator.clipboard.writeText(prompt)
      const b=document.getElementById('joule-copy-btn')
      b.textContent='✓ Copied!'; b.style.background='#107C10'
      setTimeout(()=>{b.textContent='📋 Copy';b.style.background='#0078D4'},2000)
    }catch(e){ta.select();document.execCommand('copy')}
  }
}

// ── HSI file renderer (JS port of bash _render_file) ──────────────────────
// Permissions renderer for new .md format
async function renderMdPermFile(contentArea, txt){
  // Extract ls -lah output from fenced code blocks under ## Captured Filesystemdetails
  // Also capture the _HANA Version: ... | SID: ... | Host: ... | date_ metadata line
  const lines=txt.replace(/\r\n/g,'\n').replace(/\r/g,'\n').split('\n')
  let inSection=false,inCode=false
  const capturedLines=[]
  let hanaVersionLine=''
  for(const line of lines){
    if(/^##\s+Captured Filesystemdetails/i.test(line)){inSection=true;continue}
    if(inSection){
      if(/^##?\s/.test(line)&&!/^###/.test(line)){break}
      if(/^```/.test(line.trim())){inCode=!inCode;continue}
      if(inCode) capturedLines.push(line)
      else if(!hanaVersionLine){
        const m=line.match(/^_HANA Version:\s*(.+?)_\s*$/)
        if(m) hanaVersionLine=m[1].trim()
      }
    }
  }
  const TOP_BTN=`<a href="#hsi-top" style="font-size:0.76em;text-decoration:none;color:#6c757d;padding:2px 8px;border:1px solid #dee2e6;border-radius:12px;white-space:nowrap;flex-shrink:0;" title="Top">▲ TOP</a>`
  const sections=parsePermSections(capturedLines.join('\n'))
  const tocEntries=[],parts=[]
  const versionBadge=hanaVersionLine
    ? `<div style="font-size:10px;color:#605E5C;font-weight:400;margin-top:3px;font-family:Consolas,monospace;">${escHtml(hanaVersionLine)}</div>`
    : ''
  parts.push(`<a id="hsi-top" style="display:block;"></a>`)
  parts.push(`<div class="hsi-perm-split" style="margin-bottom:8px;">
    <div class="hsi-perm-col"><div class="hsi-perm-col-header">Captured Filesystemdetails${versionBadge}</div></div>
    <div class="hsi-perm-col"><div class="hsi-perm-col-header">Comparison of working Filesystemdetails
      <button class="hsi-upload-btn" onclick="hsiPermUpload(this)">&#128196; Load reference file</button>
      <span class="hsi-ref-version-badge"></span>
    </div></div>
  </div>`)
  let idx=0
  for(const sec of sections){
    const anchor=`hsi-perm-${idx++}`
    tocEntries.push(`<li><a href="#${anchor}">${escHtml(sec.path)}</a></li>`)
    parts.push(`<div class="hsi-h4" id="${anchor}">${TOP_BTN} ls -lah ${escHtml(sec.path)}</div>`)
    parts.push(`<div class="hsi-perm-split"><div class="hsi-perm-col"><div class="hsi-log-block">${renderPermContentLines(sec.lines)}</div></div><div class="hsi-perm-col"><div class="hsi-log-block hsi-ref-section" data-ref-path="${escHtml(sec.path)}"><div class="hsi-perm-ref-empty">No reference file loaded.</div></div></div></div>`)
  }
  let out=tocEntries.length?`<div class="hsi-toc"><strong>Contents</strong><ul>${tocEntries.join('')}</ul></div>`:''
  contentArea.innerHTML=out+parts.join('\n')
  if(typeof BUNDLED_FS_REFERENCE!=='undefined')applyBundledFsRef(contentArea)
}
function _extractPermVersionLine(text){
  const m=text.match(/_HANA Version:\s*(.+?)_/)
  return m?m[1].trim():''
}
function applyBundledFsRef(container){
  if(typeof BUNDLED_FS_REFERENCE==='undefined'||!container) return
  const refSections=parsePermSections(BUNDLED_FS_REFERENCE)
  const refMap=new Map(refSections.map(s=>[s.path,s]))
  const refVer=_extractPermVersionLine(BUNDLED_FS_REFERENCE)
  const badge=container.querySelector('.hsi-ref-version-badge')
  if(badge&&refVer) badge.innerHTML=`<div style="font-size:10px;color:#605E5C;font-weight:400;margin-top:3px;font-family:Consolas,monospace;">${escHtml(refVer)}</div>`
  const capturedPaths=new Set()
  container.querySelectorAll('.hsi-ref-section[data-ref-path]').forEach(col=>{
    const path=col.getAttribute('data-ref-path')
    capturedPaths.add(path)
    col.innerHTML=refMap.has(path)
      ?renderPermContentLines(refMap.get(path).lines)
      :'<div class="hsi-perm-ref-empty" style="color:#A19F9D;">Path not in reference file</div>'
  })
  const permArea=container.querySelector('.hsi-perm-area')||container
  refSections.forEach(sec=>{
    if(!capturedPaths.has(sec.path)){
      const wrap=document.createElement('div')
      const secId='perm-ref-only-'+sec.path.replace(/[^a-zA-Z0-9]/g,'-')
      wrap.innerHTML=`<div class="hsi-h4" id="${secId}">${escHtml(sec.path)} <span style="font-size:11px;font-weight:400;color:#A19F9D;">(reference only)</span> <a href="#hsi-top" style="font-size:10px;font-weight:400;color:#0078D4;text-decoration:none;margin-left:8px;">&#9650; TOP</a></div><div class="hsi-perm-split"><div class="hsi-perm-col" style="flex:1;background:#F3F2F1;border-radius:2px;padding:8px 10px;color:#A19F9D;font-size:12px;">Path not in captured file</div><div class="hsi-perm-col hsi-perm-col-ref" style="flex:1;">${renderPermContentLines(sec.lines)}</div></div>`
      permArea.appendChild(wrap)
    }
  })
}

function renderHsiFile(text, filename){
  const lines = text.split('\n').map(l => l.replace(/\r$/, ''))
  if(filename.toLowerCase().includes('permissions')) return renderPermFile(lines)
  const tocEntries = []
  const contentParts = []
  let sectionId = 0
  let inPre = false

  for(const rawLine of lines){
    // Section header: "Something - ex.:HH:MM:SS AM"
    const secM = rawLine.match(/^(.+)\s+-\s+ex\.:.*$/)
    if(secM){
      if(inPre){ contentParts.push('</pre>'); inPre = false }
      const anchor = `hsi-s-${sectionId}`
      tocEntries.push(`<li><a href="#${anchor}">${escHtml(secM[1])}</a></li>`)
      contentParts.push(`<div class="hsi-h4" id="${anchor}"><a class="top-link" href="#hsi-top" style="font-size:0.76em;text-decoration:none;color:#6c757d;padding:2px 8px;border:1px solid #dee2e6;border-radius:12px;white-space:nowrap;flex-shrink:0;" title="Top">▲ TOP</a> ${escHtml(rawLine)}</div>`)
      sectionId++
      continue
    }

    // Transform the line
    const rendered = hsiTransformLine(rawLine)

    // Check for block-level elements that must live outside <pre>
    const isBlock = rendered.isBlock
    const html = rendered.html

    if(isBlock){
      if(inPre){ contentParts.push('</pre>'); inPre = false }
      contentParts.push(html)
    } else {
      const stripped = rawLine.trim()
      if(!inPre && stripped){
        contentParts.push('<pre class="hsi-pre">')
        inPre = true
      }
      if(inPre) contentParts.push(html)
    }
  }
  if(inPre) contentParts.push('</pre>')

  // anchor for "▲ TOP" links — only used as fallback when no banner is rendered
  let out = '<a id="hsi-top" style="display:block;"></a>'
  if(tocEntries.length){
    out += `<div class="hsi-toc"><strong>Contents</strong><ul>${tocEntries.join('')}</ul></div>`
  }
  out += contentParts.join('\n')
  return out
}

// ── Permission file rendering ──────────────────────────────────────────────
function parsePermSections(rawText){
  const sections=[]
  let cur=null
  for(const line of rawText.split('\n').map(l=>l.replace(/\r$/,''))){
    const m=line.match(/^\s*(\|[-\->]*\s+)?ls\s+-lah\s+(.+)$/)
    if(m){
      const path=m[2].trim()
      const depth=path==='/'?0:path.split('/').filter(Boolean).length
      if(depth<=2){ if(cur)sections.push(cur); cur={path,lines:[]} }
      else { if(cur)cur.lines.push(line) }
    } else { if(cur)cur.lines.push(line) }
  }
  if(cur)sections.push(cur)
  return sections
}

function renderPermContentLines(lines){
  let html='',inPre=false
  for(const rawLine of lines){
    const m=rawLine.match(/^\s*(\|[-\->]*\s+)?ls\s+-lah\s+(.+)$/)
    if(m){
      const path=m[2].trim()
      const depth=path==='/'?0:path.split('/').filter(Boolean).length
      if(depth>2){
        if(inPre){html+='</pre>';inPre=false}
        html+=`<div class="hsi-perm-ls-subheader">${escHtml(rawLine.trim())}</div>`
      }
      continue
    }
    if(/^-{20,}$/.test(rawLine.trim())){
      if(inPre){html+='</pre>';inPre=false}
      html+='<hr class="hsi-sep">'
      continue
    }
    if(!inPre&&rawLine.trim()){html+='<pre class="hsi-pre">';inPre=true}
    if(inPre)html+=escHtml(rawLine)+'\n'
  }
  if(inPre)html+='</pre>'
  return html
}

function renderPermFile(lines){
  const TOP_BTN=`<a href="#hsi-top" style="font-size:0.76em;text-decoration:none;color:#6c757d;padding:2px 8px;border:1px solid #dee2e6;border-radius:12px;white-space:nowrap;flex-shrink:0;" title="Top">▲ TOP</a>`
  const tocEntries=[],sectionId_={v:0}
  let mainHeader=null,capturedRawLines=[],state='scanning'

  for(const line of lines){
    if(state==='scanning'){
      const secM=line.match(/^(.+)\s+-\s+ex\.:.*$/)
      if(secM)mainHeader=line
      if(/^<div class=["']log-block["']>$/.test(line.trim()))state='in-logblock'
    } else if(state==='in-logblock'){
      if(line.trim()==='</div>')state='done'
      else capturedRawLines.push(line)
    }
  }

  const sections=parsePermSections(capturedRawLines.join('\n'))
  let body=''

  if(mainHeader){
    const secM=mainHeader.match(/^(.+)\s+-\s+ex\.:.*$/)
    if(secM){
      const anchor=`hsi-s-${sectionId_.v++}`
      tocEntries.push(`<li><a href="#${anchor}">${escHtml(secM[1])}</a></li>`)
      body+=`<div class="hsi-h4" id="${anchor}">${TOP_BTN} ${escHtml(mainHeader)}</div>`
    }
  }

  body+=`<div class="hsi-perm-split" style="margin-bottom:8px;">
    <div class="hsi-perm-col"><div class="hsi-perm-col-header">Captured Filesystemdetails</div></div>
    <div class="hsi-perm-col"><div class="hsi-perm-col-header">Comparison of working Filesystemdetails
      <button class="hsi-upload-btn" onclick="hsiPermUpload(this)">&#128196; Load reference file</button>
    </div></div>
  </div>`

  for(const sec of sections){
    const anchor=`hsi-perm-${sectionId_.v++}`
    tocEntries.push(`<li><a href="#${anchor}">${escHtml(sec.path)}</a></li>`)
    body+=`<div class="hsi-h4" id="${anchor}">${TOP_BTN} ls -lah ${escHtml(sec.path)}</div>`
    body+=`<div class="hsi-perm-split">`
    body+=`<div class="hsi-perm-col"><div class="hsi-log-block">${renderPermContentLines(sec.lines)}</div></div>`
    body+=`<div class="hsi-perm-col"><div class="hsi-log-block hsi-ref-section" data-ref-path="${escHtml(sec.path)}"><div class="hsi-perm-ref-empty">No reference file loaded.</div></div></div>`
    body+=`</div>`
  }

  let out=`<a id="hsi-top" style="display:block;"></a>`
  if(tocEntries.length)out+=`<div class="hsi-toc"><strong>Contents</strong><ul>${tocEntries.join('')}</ul></div>`
  return out+body
}

function hsiTransformLine(line){
  // Replace placeholders before HTML escaping
  let s = line
  s = s.replace(/<font color="red">WARNING:<\/font>/g, '§WARN§')
  s = s.replace(/<font color=red>WARNING:<\/font>/g, '§WARN§')
  s = s.replace(/PASSED:/g, '§PASS§')
  s = s.replace(/WARNING:/g, '§WARN§')
  // FAILED:
  s = s.replace(/FAILED:/g, '§FAIL§')

  // Detect block-level markers before escaping
  const isLogBlock = s.includes('<div class="log-block"') || s.includes("<div class='log-block'")
  const isLogBlockClose = s.trim() === '</div>' && !s.includes('<div')
  const isPermSplit = s.includes('<div class="perm-split"') || s.includes("<div class='perm-split'")
  const isPermCol = s.includes('<div class="perm-col"') || s.includes("<div class='perm-col'")
  const isPermColHdr = s.includes('<div class="perm-col-header"') || s.includes("<div class='perm-col-header'")
  const isPermRefEmpty = s.includes('<div class="perm-ref-empty"') || s.includes("<div class='perm-ref-empty'")
  const isDivClose = s.trim() === '</div>'
  const hasInput = s.includes('<input type="file"')
  const hasButton = s.includes('<button class="perm-upload-btn"')
  const isSep = /^-{20,}$/.test(s.trim())

  if(hasInput) return { isBlock: true, html: '' }

  if(isLogBlock || isPermSplit || isPermCol || isPermColHdr || isPermRefEmpty || isDivClose || hasButton || isSep){
    let html = s

    // log-block: remap class
    html = html.replace(/<div class=['"]log-block['"]\s*(id=['"][^'"]*['"])?\s*>/gi, (m, idAttr) => {
      return `<div class="hsi-log-block"${idAttr ? ' '+idAttr : ''}>`
    })
    html = html.replace(/<div class=['"]perm-split['"]>/gi, '<div class="hsi-perm-split">')
    html = html.replace(/<div class=['"]perm-col['"]>/gi, '<div class="hsi-perm-col">')
    html = html.replace(/<div class=['"]perm-col-header['"]>/gi, '<div class="hsi-perm-col-header">')
    html = html.replace(/<div class=['"]perm-ref-empty['"]>/gi, '<div class="hsi-perm-ref-empty">')
    html = html.replace(/<button class="perm-upload-btn"([^>]*?)>/gi, (m,attrs)=>{
      const a=attrs.replace(/\s*onclick\s*=\s*(?:"[^"]*"|'[^']*')/gi,'')
      return `<button class="hsi-upload-btn"${a} onclick="hsiPermUpload(this)">`
    })
    // sep
    if(isSep) html = '<hr class="hsi-sep">'
    // badges
    html = html.replace(/§PASS§/g, '<span class="hsi-badge-pass">✓ PASSED:</span>')
    html = html.replace(/§WARN§/g, '<span class="hsi-badge-warn">WARNING:</span>')
    html = html.replace(/§FAIL§/g, '<span class="hsi-badge-fail">✗ FAILED:</span>')
    return { isBlock: true, html }
  }

  // Regular line: HTML-escape then inline transforms
  let esc = s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')

  // Restore inline allowed tags via regex (mirrors the perl in the bash script)
  // links
  esc = esc.replace(/&lt;a\s+href=(?:"?|'?)([^"' >]+)(?:"?|'?)(?:\s+target=(?:"?|'?)[^"' >]*(?:"?|'?))?\s*&gt;(.*?)&lt;\/a&gt;/gi,
    '<a href="$1" target="_blank" rel="noopener noreferrer">$2</a>')
  // font color
  esc = esc.replace(/&lt;font\s+color=(?:"?|'?)([^"' >]+)(?:"?|'?)&gt;(.*?)&lt;\/font&gt;/gi,
    '<span style="color:$1">$2</span>')
  // inline tags
  esc = esc.replace(/&lt;(\/?)(b|u|i|strong|em|code|br|small|mark)&gt;/gi, '<$1$2>')
  // badges
  esc = esc.replace(/§PASS§/g, '<span class="hsi-badge-pass">✓ PASSED:</span>')
  esc = esc.replace(/§WARN§/g, '<span class="hsi-badge-warn">WARNING:</span>')
  esc = esc.replace(/§FAIL§/g, '<span class="hsi-badge-fail">✗ FAILED:</span>')

  return { isBlock: false, html: esc }
}

// (activateNav already handles HSI panel hide inline)

;(function(){
  const handle=document.getElementById('nav-resize-handle')
  const nav=document.getElementById('navTree')
  if(!handle||!nav) return
  let dragging=false, startX=0, startW=0
  handle.addEventListener('mousedown',e=>{
    dragging=true; startX=e.clientX; startW=nav.offsetWidth
    handle.classList.add('dragging')
    document.body.style.cursor='col-resize'
    document.body.style.userSelect='none'
    e.preventDefault()
  })
  document.addEventListener('mousemove',e=>{
    if(!dragging) return
    const w=Math.min(500,Math.max(120,startW+(e.clientX-startX)))
    nav.style.width=w+'px'
  })
  document.addEventListener('mouseup',()=>{
    if(!dragging) return
    dragging=false
    handle.classList.remove('dragging')
    document.body.style.cursor=''
    document.body.style.userSelect=''
  })
})()
