(function(root,factory){
  const api=factory();
  if(typeof module==="object"&&module.exports)module.exports=api;
  if(root)root.FaceArenaGameEngine=api;
})(typeof globalThis!=="undefined"?globalThis:this,function(){
  "use strict";
  const ACTIVE=new Set(["queued","matched","confirmed","voting","champion"]);
  const DEMO_ID=/^(demo[_-]|mock[_-]|bot[_-])/i;
  const idEq=(a,b)=>String(a)===String(b);
  const clone=x=>JSON.parse(JSON.stringify(x));
  function normalizeQueue(photos){
    const list=photos.map((p,index)=>({...p,_queueOrder:Number.isFinite(p._queueOrder)?p._queueOrder:index}));
    let next=list.reduce((m,p)=>Math.max(m,p._queueOrder),-1)+1;
    list.forEach(p=>{if(p.status==="queued"&&!Number.isFinite(p.queueSeq))p.queueSeq=next++});
    return list;
  }
  function queueCompare(a,b){
    const at=Number(a.queuedAt)||0,bt=Number(b.queuedAt)||0;
    if(at!==bt)return at-bt;
    const as=Number.isFinite(a.queueSeq)?a.queueSeq:Number(a._queueOrder)||0;
    const bs=Number.isFinite(b.queueSeq)?b.queueSeq:Number(b._queueOrder)||0;
    return as-bs;
  }
  function activeForOwner(photos,photo){
    const owner=photo.userId??photo.ownerId??"__local_user__";
    return photos.filter(p=>ACTIVE.has(p.status)&&(p.userId??p.ownerId??"__local_user__")===owner).length;
  }
  function laneReady(lane){
    if(!lane||lane.isMock||lane.userPhotoId||lane.openingOpponentPhotoId)return false;
    if(lane.stage==="w"||lane.stage==="v")return false;
    return lane.stage==="empty"||lane.stage==="done"||lane.stage==="cancelled"||lane.stage==null;
  }
  function ownerOf(photo){return photo.userId??photo.ownerId??"__local_user__"}
  function pairKey(a,b){return [String(a),String(b)].sort().join("::")}
  function selectNextAssignment(photos,lanes,pairExclusions=[]){
    const excludedPairs=new Set(pairExclusions.map(pair=>Array.isArray(pair)?pairKey(pair[0],pair[1]):pairKey(pair.photoLow??pair.low,pair.photoHigh??pair.high)));
    const normalized=normalizeQueue(photos);
    const ordered=normalized.filter(p=>p.status==="queued"&&activeForOwner(normalized,p)<=3).sort(queueCompare);
    const occupied=new Set(),reservedLanes=new Set();
    lanes.forEach(l=>{if(l.userPhotoId!=null)occupied.add(String(l.userPhotoId));if(l.championPhotoId!=null)occupied.add(String(l.championPhotoId));if(l.openingOpponentPhotoId!=null)occupied.add(String(l.openingOpponentPhotoId))});
    photos.forEach(p=>{if(p.status==="matched"&&p.targetLaneId!=null)reservedLanes.add(String(p.targetLaneId))});
    const availableLanes=[...lanes].filter(l=>Number(l.id)>=1&&Number(l.id)<=10&&laneReady(l)&&!reservedLanes.has(String(l.id))).sort((a,b)=>Number(a.id)-Number(b.id));
    for(const lane of availableLanes){
      if(lane.championPhotoId){
        const champion=normalized.find(p=>idEq(p.id,lane.championPhotoId));
        const challenger=ordered.find(p=>!occupied.has(String(p.id))&&(!champion||ownerOf(p)!==ownerOf(champion))&&(!champion||!excludedPairs.has(pairKey(champion.id,p.id))));
        if(challenger)return {photoId:challenger.id,laneId:lane.id};
        continue;
      }
      const first=ordered.find(p=>!occupied.has(String(p.id))&&ordered.some(q=>!idEq(q.id,p.id)&&!occupied.has(String(q.id))&&ownerOf(q)!==ownerOf(p)&&!excludedPairs.has(pairKey(p.id,q.id))));
      if(!first)continue;
      const second=ordered.find(q=>!idEq(q.id,first.id)&&!occupied.has(String(q.id))&&ownerOf(q)!==ownerOf(first)&&!excludedPairs.has(pairKey(first.id,q.id)));
      if(second)return {photoId:first.id,opponentPhotoId:second.id,laneId:lane.id,opening:true};
    }
    return null;
  }
  function assignChallenger(state,assignment,battleUid,now){
    const next=clone(state),p=next.photos.find(x=>idEq(x.id,assignment.photoId)),lane=next.lanes.find(x=>idEq(x.id,assignment.laneId));
    if(!p||p.status!=="queued"||!lane||!laneReady(lane)||activeForOwner(next.photos,p)>3)return {state,assigned:false,reason:"ineligible"};
    if(next.lanes.some(l=>idEq(l.userPhotoId,p.id)||idEq(l.championPhotoId,p.id)||idEq(l.openingOpponentPhotoId,p.id)))return {state,assigned:false,reason:"duplicate"};
    let opponent=null;
    if(assignment.opening){
      opponent=next.photos.find(x=>idEq(x.id,assignment.opponentPhotoId));
      if(lane.championPhotoId||!opponent||opponent.status!=="queued"||ownerOf(opponent)===ownerOf(p)||activeForOwner(next.photos,opponent)>3)return {state,assigned:false,reason:"invalid-opening-pair"};
      if(next.lanes.some(l=>idEq(l.userPhotoId,opponent.id)||idEq(l.championPhotoId,opponent.id)||idEq(l.openingOpponentPhotoId,opponent.id)))return {state,assigned:false,reason:"duplicate"};
      opponent.status="confirmed";opponent.battleId=lane.id;opponent.battleUid=battleUid;opponent.side="B";opponent.matchDeadline=null;opponent.matchedAt=now;
      p.side="R";p.opponentName=opponent.name||"Участник";p.opponentImg=opponent.dataUrl||"";
      lane.openingOpponentPhotoId=opponent.id;lane.openingOpponentName=opponent.name||"Участник";lane.openingOpponentImg=opponent.dataUrl||"";
    }else{
      p.side=lane.championSide==="R"?"B":"R";
      p.opponentName=lane.championName;p.opponentImg=lane.championImg;
    }
    p.status="confirmed";p.battleId=lane.id;p.battleUid=battleUid;p.matchDeadline=null;p.matchedAt=now;
    lane.userPhotoId=p.id;lane.battleUid=battleUid;lane.stage="w";lane.stageStarted=now;lane.stageEnd=now+70000;lane.redVotes=0;lane.blueVotes=0;lane._finalized=false;lane.isMock=false;
    if(p.side==="R"){lane.redName="you";lane.blueName=(p.opponentName||"opponent").replace("@","")}
    else{lane.blueName="you";lane.redName=(p.opponentName||"opponent").replace("@","")}
    return {state:next,assigned:true,photoId:p.id,opponentPhotoId:opponent&&opponent.id,laneId:lane.id,opening:!!opponent};
  }
  function resolveBattle(state,laneId,now){
    const next=clone(state),lane=next.lanes.find(x=>idEq(x.id,laneId));
    if(!lane||lane._finalized||lane.stage!=="v")return {state,changed:false,result:null};
    const p=next.photos.find(x=>idEq(x.id,lane.userPhotoId));
    const uid=lane.battleUid;
    if(!p)return {state,changed:false,result:null};
    const openingOpponent=lane.openingOpponentPhotoId!=null?next.photos.find(x=>idEq(x.id,lane.openingOpponentPhotoId)):null;
    const mine=p.side==="R"?Number(lane.redVotes)||0:Number(lane.blueVotes)||0;
    const theirs=p.side==="R"?Number(lane.blueVotes)||0:Number(lane.redVotes)||0;
    const totalVotes=mine+theirs;
    const noContest=totalVotes<2||(totalVotes===2&&mine===1&&theirs===1);
    if(noContest){
      const pairIds=openingOpponent?[p.id,openingOpponent.id]:[p.id,lane.championPhotoId].filter(Boolean);
      if(pairIds.length===2){
        next.pairExclusions=next.pairExclusions||[];
        if(!next.pairExclusions.some(pair=>pairKey(pair[0],pair[1])===pairKey(pairIds[0],pairIds[1])))next.pairExclusions.push(pairIds);
      }
      for(const participant of [p,openingOpponent].filter(Boolean)){
        participant.status=participant.id===lane.championPhotoId?"champion":"queued";
        participant.battleId=null;participant.battleUid=null;participant.targetLaneId=null;
        participant.side=null;participant.opponentName=null;participant.opponentImg=null;
        participant.completedAt=null;participant.matchedAt=null;participant.matchDeadline=null;
        participant.openingOpponentPhotoId=null;participant.openingPairPrimaryId=null;
      }
      lane.userPhotoId=null;lane.openingOpponentPhotoId=null;lane.openingOpponentName=null;lane.openingOpponentImg=null;
      lane.stage="done";lane._finalized=true;lane.redVotes=0;lane.blueVotes=0;
      return {state:next,changed:true,result:{laneId:lane.id,battleUid:uid,outcome:"no-contest",noContest:true,opening:!!openingOpponent,championPhotoId:lane.championPhotoId,completedPhotoIds:[],wasChampion:idEq(p.id,lane.championPhotoId)}};
    }
    const outcome=mine>theirs?"win":mine<theirs?"lose":"draw";
    if(openingOpponent&&!lane.championPhotoId){
      const stats=next.participantStats||(next.participantStats={});
      const pStats=stats[String(p.id)]||(stats[String(p.id)]={wins:0,losses:0,defenses:0,currentStreak:0,bestStreak:0,name:p.name||"Участник",img:p.dataUrl||"",isChampion:false,laneId:null});
      const oStats=stats[String(openingOpponent.id)]||(stats[String(openingOpponent.id)]={wins:0,losses:0,defenses:0,currentStreak:0,bestStreak:0,name:openingOpponent.name||"Участник",img:openingOpponent.dataUrl||"",isChampion:false,laneId:null});
      let winner=null,loser=null;
      // Opening matches establish the first lane holder only. They do not
      // affect lifetime standings, losses, or consecutive-win streaks.
      if(outcome==="win"){winner=p;loser=openingOpponent}
      else if(outcome==="lose"){winner=openingOpponent;loser=p}
      else{p.status="completed";p.result="draw";p.completedAt=now;p.battleId=null;openingOpponent.status="completed";openingOpponent.result="draw";openingOpponent.completedAt=now;openingOpponent.battleId=null}
      if(winner){
        winner.status="champion";winner.result="win";winner.completedAt=null;winner.battleId=lane.id;
        loser.status="completed";loser.result="lose";loser.completedAt=now;loser.battleId=null;
        const ws=stats[String(winner.id)],ls=stats[String(loser.id)];ws.isChampion=true;ws.laneId=lane.id;ls.isChampion=false;ls.laneId=null;
        lane.championPhotoId=winner.id;lane.championSide=winner.side;lane.championName=ws.name;lane.championImg=winner.dataUrl||"";lane.championStreak=ws.currentStreak;
      }
      if(!next.history)next.history=[];
      for(const [person,side,result,myVotes,oppVotes] of [[p,"R",outcome,mine,theirs],[openingOpponent,"B",outcome==="win"?"lose":outcome==="lose"?"win":"draw",theirs,mine]]){
        if(!next.history.some(h=>String(h.battleUid)===String(uid)&&idEq(h.photoId,person.id))){
          next.history.unshift({photoId:person.id,battleId:lane.id,battleUid:uid,laneId:lane.id,side,result,myVotes,oppVotes,opponentName:person.id===p.id?openingOpponent.name:p.name,opponentImg:person.id===p.id?openingOpponent.dataUrl:p.dataUrl,completedAt:now,myImg:person.dataUrl||"",championAfter:person.status==="champion"});
        }
      }
      p.openingOpponentPhotoId=null;openingOpponent.openingPairPrimaryId=null;
      lane.userPhotoId=null;lane.openingOpponentPhotoId=null;lane.openingOpponentName=null;lane.openingOpponentImg=null;lane.stage="done";lane._finalized=true;lane.redVotes=0;lane.blueVotes=0;
      return {state:next,changed:true,result:{laneId:lane.id,battleUid:uid,outcome,opening:true,championPhotoId:lane.championPhotoId,completedPhotoIds:[p.id,openingOpponent.id],wasChampion:false}};
    }
    const stats=next.participantStats||(next.participantStats={});
    const st=stats[String(p.id)]||(stats[String(p.id)]={wins:0,losses:0,defenses:0,currentStreak:0,bestStreak:0,name:p.name||"Участник",img:p.dataUrl||"",isChampion:false,laneId:null});
    const oldId=lane.championPhotoId,wasChampion=oldId!=null&&idEq(oldId,p.id);
    const completed=[];
    if(outcome==="win"){
      st.wins=(st.wins||0)+1;st.currentStreak=(st.currentStreak||0)+1;st.bestStreak=Math.max(st.bestStreak||0,st.currentStreak);
      if(wasChampion)st.defenses=(st.defenses||0)+1;
      else if(oldId!=null){
        const old=next.photos.find(x=>idEq(x.id,oldId));
        if(old){old.status="completed";old.result="lose";old.completedAt=now;old.battleId=null;old.battleUid=uid;completed.push(old.id)}
        const oldStats=stats[String(oldId)]||(stats[String(oldId)]={wins:0,losses:0,defenses:0,currentStreak:0,bestStreak:0,name:old&&old.name||"Участник",img:old&&old.dataUrl||"",isChampion:false,laneId:null});
        oldStats.isChampion=false;oldStats.laneId=null;oldStats.losses=(oldStats.losses||0)+1;oldStats.currentStreak=0;
        if(old&&!next.history.some(h=>String(h.battleUid)===String(uid)&&idEq(h.photoId,old.id))){
          next.history.unshift({photoId:old.id,battleId:lane.id,battleUid:uid,laneId:lane.id,side:old.side,result:"lose",myVotes:theirs,oppVotes:mine,opponentName:p.name||"Участник",opponentImg:p.dataUrl||"",completedAt:now,myImg:old.dataUrl||"",championAfter:false});
        }
      }
      lane.championPhotoId=p.id;lane.championSide=p.side;lane.championName=st.name;lane.championImg=p.dataUrl;lane.championStreak=st.currentStreak;
      st.isChampion=true;st.laneId=lane.id;p.status="champion";p.completedAt=null;p.result="win";p.battleId=lane.id;
    }else if(outcome==="lose"){
      st.losses=(st.losses||0)+1;st.currentStreak=0;
      p.status="completed";p.result=outcome;p.completedAt=now;p.battleId=null;completed.push(p.id);
      if(wasChampion){lane.championPhotoId=null;lane.championSide=null;lane.championName=null;lane.championImg=null;lane.championStreak=0;st.isChampion=false;st.laneId=null}
    }else if(wasChampion){
      p.status="champion";p.result="draw";p.completedAt=null;p.battleId=lane.id;
    }else{
      p.status="completed";p.result="draw";p.completedAt=now;p.battleId=null;completed.push(p.id);
    }
    if(!next.history)next.history=[];
    if(!next.history.some(h=>String(h.battleUid)===String(uid)&&idEq(h.photoId,p.id))){
      next.history.unshift({photoId:p.id,battleId:lane.id,battleUid:uid,laneId:lane.id,side:p.side,result:outcome,myVotes:mine,oppVotes:theirs,opponentName:p.opponentName,opponentImg:p.opponentImg,completedAt:now,myImg:p.dataUrl,championAfter:p.status==="champion"});
    }
    lane.userPhotoId=null;lane.stage="done";lane._finalized=true;lane.redVotes=0;lane.blueVotes=0;
    return {state:next,changed:true,result:{laneId:lane.id,battleUid:uid,outcome,winnerSide:outcome==="win"?p.side:outcome==="lose"?(p.side==="R"?"B":"R"):"draw",championPhotoId:lane.championPhotoId,completedPhotoIds:completed,wasChampion}};
  }
  function cancelBattle(state,laneId,now){
    const next=clone(state),lane=next.lanes.find(x=>idEq(x.id,laneId));
    if(!lane||lane._finalized||!(lane.stage==="w"||lane.stage==="v"))return {state,changed:false};
    const p=next.photos.find(x=>idEq(x.id,lane.userPhotoId));
    const openingOpponent=lane.openingOpponentPhotoId!=null?next.photos.find(x=>idEq(x.id,lane.openingOpponentPhotoId)):null;
    const hasNextQueued=next.photos.some(x=>!idEq(x.id,p&&p.id)&&!idEq(x.id,openingOpponent&&openingOpponent.id)&&x.status==="queued");
    for(const participant of [p,openingOpponent].filter(Boolean)){
      // Release both members of an opening pair together; never strand one as confirmed.
      participant.status=hasNextQueued?"cancelled":"queued";
      participant.battleId=null;participant.battleUid=null;participant.targetLaneId=null;
      participant.matchedAt=null;participant.matchDeadline=null;participant.completedAt=null;
      participant.side=null;participant.opponentName=null;participant.opponentImg=null;
      participant.openingOpponentPhotoId=null;participant.openingPairPrimaryId=null;
    }
    // Release the lane but preserve its incumbent champion.
    lane.userPhotoId=null;lane.openingOpponentPhotoId=null;lane.openingOpponentName=null;lane.openingOpponentImg=null;lane.stage="done";lane._finalized=true;
    lane.redVotes=0;lane.blueVotes=0;
    return {state:next,changed:true};
  }
  function buildRanking(participantStats,photos){
    return Object.keys(participantStats||{}).filter(id=>!DEMO_ID.test(id)).map(id=>{
      const s=participantStats[id]||{},p=(photos||[]).find(x=>idEq(x.ownerId??x.userId??x.id,id));
      if(s.isDemo||s.demoOnly||p&&(p.isDemo||p.demoOnly))return null;
      const best=Number(s.bestStreak)||0,streak=Number(s.currentStreak)||0;
      if(Number(s.wins||0)<5||best<5)return null;
      return {id,name:s.name||"Участник",img:s.img||(p&&p.dataUrl)||"",wins:Number(s.wins)||0,losses:Number(s.losses)||0,defenses:Number(s.defenses)||0,streak,best,isChampion:!!s.isChampion||!!(p&&p.status==="champion"),isLegendary:streak>=10,laneId:s.laneId||null};
    }).filter(Boolean).sort((a,b)=>b.wins-a.wins||b.streak-a.streak||b.best-a.best||String(a.id).localeCompare(String(b.id)));
  }
  return {normalizeQueue,selectNextAssignment,assignChallenger,resolveBattle,cancelBattle,buildRanking};
});
