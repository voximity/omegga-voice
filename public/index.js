const socket = io();
const peer = new Peer({host: location.hostname, port: location.port, path: "/peerjs"});
let authed = false;
let me = null;

const peers = {};

let mapScale = 0.3;
let useProximity = true;
let usePanning = true;
let maxVoiceDistance = 100;
let falloffFactor = 2;
let deadVoice = true;
let useTTS = false;
let showChat = true;
let chatTTS = false;
let othersOnMinimap = true;
let deadNonProximity = true;

function setNetConfig(config) {
  maxVoiceDistance = config.maxVoiceDistance;
  falloffFactor = config.falloffFactor;
  useProximity = config.useProximity;
  usePanning = config.usePanning;
  deadVoice = config.deadVoice;
  mapScale = config.mapScale;
  useTTS = config.useTTS;
  showChat = config.showChat;
  chatTTS = config.chatTTS;
  othersOnMinimap = config.othersOnMinimap;
  deadNonProximity = config.deadNonProximity;
}

async function getUserMedia() {
  try {
    return await navigator.mediaDevices.getUserMedia({audio: true});
  } catch (e) {
    return null;
  }
}

function tts(text, optionMap) {
  if (!useTTS) return;

  const msg = new SpeechSynthesisUtterance();
  msg.text = text;
  msg.volume = 0.5;
  for (const option in optionMap) {
    msg[option] = optionMap[option];
  }

  window.speechSynthesis.speak(msg);
  let timeout;
  msg.addEventListener("start", () => timeout = setTimeout(() => window.speechSynthesis.cancel(), 5000));
  msg.addEventListener("end", () => clearTimeout(timeout));
}

peer.on("open", (id) => {
  socket.emit("hi", {peerId: id});
});

// auth code copy button
document.getElementById("auth-code-copy").addEventListener("click", () => {
  document.getElementById("auth-code").select();
  document.execCommand("copy");
});

// when the server gets back to us with our code, inform the frontend
socket.on("hi", ({code, serverName, hostName, config}) => {
  const header = document.getElementById("server-header");
  header.innerHTML = `${hostName}'s <b>${serverName}</b>`;
  header.style.display = "block";

  const authCodeElement = document.getElementById("auth-code");
  authCodeElement.value = `/auth ${code}`;

  setNetConfig(config);
});

// when the server notices we left, refresh the page
// this is also emitted when the socket initially starts
// for old clients to catch back up
socket.on("bye", () => {
  setTimeout(() => window.location.reload(), 1000); // give a second to reload
});

// when the player authenticates, we need to switch the frontend over
let canvas;
let notoContainer;

function addNoto(innerHTML, notoClass) {
  if (notoContainer == null) return;

  const noto = document.createElement("div");
  noto.classList.add("noto");
  if (notoClass) noto.classList.add(notoClass);
  noto.innerHTML = innerHTML;

  notoContainer.prepend(noto);

  while (notoContainer.childElementCount >= 100) {
    notoContainer.removeChild(notoContainer.childNodes[99]);
  }
}

socket.on("authenticated", async (user) => {
  document.getElementsByClassName("auth-code")[0].remove();
  document.getElementById("desc").innerHTML = `You are logged in as <b>${user}</b>. Running into any issues? Check the <a href="/faq.html" target="_blank">FAQ</a>.`;

  // create the container
  const container = document.createElement("div");
  container.id = "content-container";

  // create the canvas
  canvas = document.createElement("canvas");
  canvas.id = "canvas";
  canvas.width = 300;
  canvas.height = 300;
  container.appendChild(canvas);

  // create the noto container
  notoContainer = document.createElement("div");
  notoContainer.id = "noto-container";
  container.appendChild(notoContainer);

  // finally append the container to the scene
  document.getElementById("page-body").appendChild(container);

  // and add a notification.
  addNoto("Connected to voice chat.");
  tts("connected to voice chat.");

  authed = true;
  me = user;
});

function onCallStart(name, call, stream) {
  const ctx = new (window.AudioContext || window.webkitAudioContext)();

  const source = ctx.createMediaStreamSource(new MediaStream([stream.getAudioTracks()[0]]));
  
  const leftGain = ctx.createGain();
  const rightGain = ctx.createGain();

  source.connect(leftGain);
  source.connect(rightGain);

  const merger = ctx.createChannelMerger(2);
  leftGain.connect(merger, 0, 0);
  rightGain.connect(merger, 0, 1);

  merger.connect(ctx.destination);

  const audio = document.createElement("video");
  audio.srcObject = stream;
  audio.muted = true;
  audio.style.display = "none";
  audio.onloadedmetadata = () => audio.play();

  document.body.appendChild(audio);

  peers[call.peer] = {name, audio, leftGain, rightGain, call, stream};
  console.log("new audio object for peer " + call.peer);
}

// when a new player joins, we should call them using peerjs
socket.on("peer join", async ({name, peerId}) => {
  if (!authed) return;
  
  // don't do anything when it refers to us
  if (peerId == peer.id) return;

  // add a noto
  addNoto(`<b>${name}</b> joined the voice chat.`, "noto-yellow");
  tts(`${name} joined the voice chat.`);

  console.log("calling " + name + " (peer ID " + peerId + ")");
  const mediaStream = await getUserMedia();

  // wait 500 ms, otherwise the peer might not consider auth in time
  setTimeout(() => {
    const call = peer.call(peerId, mediaStream);
    call.on("stream", (str) => onCallStart(name, call, str));
    call.on("close", () => {
      console.log("call closed with " + name);
      delete peers[peerId];
    });
  }, 500);
});

// when a player leaves, we should end their call
socket.on("peer leave", async ({name, peerId}) => {
  if (peers[peerId] == null) return;

  addNoto(`<b>${name}</b> left the voice chat.`);
  tts(`${name} left the voice chat.`);

  console.log("call closed with " + name);
  delete peers[peerId];
});

// when a message is sent, show it or utter it if settings apply
socket.on("chat", async ({name, message}) => {
  if (!authed) return;

  if (showChat)
    addNoto(`<b>${name}:</b> ${message}`);
  
  if (chatTTS) {
    let rate = 1;
    let pitch = 1;

    if (message.startsWith("fast:")) {
      rate = 1.4;
      message = message.substring(5);
    } else if (message.startsWith("slow:")) {
      rate = 0.35;
      message = message.substring(5);
    } else if (message.startsWith("high:")) {
      pitch = 1.7;
      message = message.substring(5);
    } else if (message.startsWith("low:")) {
      pitch = 0.4;
      message = message.substring(4);
    }

    tts(`${name} says ${message}`, {volume: 0.5, rate, pitch});
  }
});

// when we want to leave, disconnect
window.addEventListener("beforeunload", () => {
  socket.disconnect();
});

// we should also forcibly accept calls
peer.on("call", async (call) => {
  if (!authed) return;

  console.log("accepting call from peer ID " + call.peer);

  const mediaStream = await getUserMedia();

  call.answer(mediaStream);
  call.on("stream", (str) => onCallStart(null, call, str));
  call.on("close", () => {
    console.log("anonymous call closed");
    delete peers[call.peer];
  });
});

// keep track of player movement
socket.on("transforms", (transforms) => {
  if (!authed) return;

  const ctx = canvas.getContext("2d");
  ctx.globalCompositeOperation = "destination-over";
  ctx.font = "12px Arial";
  ctx.clearRect(0, 0, 300, 300);

  // figure out which transform is us
  let myTransform;
  for (const transform of transforms) {
    if (transform.name == me) {
      myTransform = transform;
      break;
    }
  }

  if (myTransform == null) return;

  // draw the circle representing hearing range
  if (useProximity) {
    ctx.beginPath();
    ctx.arc(150, 150, maxVoiceDistance * mapScale, 0, 2 * Math.PI, false);
    ctx.strokeStyle = "#aaa";
    ctx.stroke();
  }

  // prepare for player rendering
  ctx.fillStyle = "#ddd";
  ctx.strokeStyle = "#c00";
  ctx.textAlign = "center";

  for (const transform of transforms) {
    const peerAudio = peers[transform.peerId];
    
    const diffX = transform.x - myTransform.x;
    const diffY = transform.y - myTransform.y;
    const pX = diffY * mapScale + 150;
    const pY = -diffX * mapScale + 150;

    if ((othersOnMinimap || transform == myTransform) && !transform.isDead) {
      ctx.fillText(transform.name, pX, pY + 4);

      // draw their look vector
      const yaw = transform.yaw * Math.PI / 180;
      const yawsin = Math.sin(yaw);
      const yawcos = Math.cos(yaw);
      ctx.beginPath();
      ctx.moveTo(pX + yawsin * 5, pY - yawcos * 5);
      ctx.lineTo(pX + yawsin * 20, pY - yawcos * 20);
      ctx.stroke();
    }

    // if they have a peer id, set their sound accordingly
    if (transform.peerId && peerAudio) {
      const theta = Math.atan2(-diffX, diffY) - (myTransform.yaw * Math.PI / 180);

      if (!deadVoice && deadNonProximity && transform.isDead && myTransform.isDead) {
        // voice on death is disabled
        // dead players can talk globally
        // the player is dead
        // so is the listener
        peerAudio.leftGain.gain.value = 1;
        peerAudio.rightGain.gain.value = 1;
        continue;
      }

      if (!deadVoice && deadNonProximity && !transform.isDead && myTransform.isDead) {
        // same as above, but the target is not dead but we are
        // we want to hear them at a slightly lower volume
        peerAudio.leftGain.gain.value = 0.4;
        peerAudio.rightGain.gain.value = 0.4;
        continue;
      }

      if (!deadVoice && transform.isDead) {
        // this person is dead, don't transmit their voice
        peerAudio.leftGain.gain.value = 0;
        peerAudio.rightGain.gain.value = 0;
        continue;
      }

      if (useProximity) {
        const dist = Math.hypot(transform.x - myTransform.x, transform.y - myTransform.y, transform.z - myTransform.z);
        if (dist < maxVoiceDistance) {
          const vdist = dist / maxVoiceDistance;
          const volscale = Math.exp(-vdist * falloffFactor) * (1 - vdist);

          if (usePanning) {
            // thanks cake
            const cos = Math.cos(-theta);
            const sin = Math.sin(-theta);

            let lvol = (Math.pow((cos < 0 ? cos : 0), 2) + Math.pow(sin, 2));
            let rvol = (Math.pow((cos > 0 ? cos : 0), 2) + Math.pow(sin, 2));

            lvol *= volscale;
            rvol *= volscale;

            peerAudio.leftGain.gain.value = lvol;
            peerAudio.rightGain.gain.value = rvol;
          } else {
            peerAudio.leftGain.gain.value = volscale;
            peerAudio.rightGain.gain.value = volscale;
          }
        } else {
          peerAudio.leftGain.gain.value = 0;
          peerAudio.rightGain.gain.value = 0;
        }
      } else {
        peerAudio.leftGain.gain.value = 1;
        peerAudio.rightGain.gain.value = 1;
      }
    }
  }

  // draw a player list in the corner of the canvas
  ctx.font = "14px Arial";
  ctx.fillStyle = "#eee";
  ctx.textAlign = "left";
  let j = 0;
  const names = transforms.filter((t) => t.peerId).map((t) => t.name);
  names.unshift("Connected:");
  for (let i = 0; i < names.length; i++) {
    ctx.fillText(names[i], 10, 20 + i * 16);
  }
});
