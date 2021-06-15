const express = require("express");
const http = require("http");
const https = require("https");
const io = require("socket.io");
const fs = require("fs");
const pem = require("pem").promisified;
const {ExpressPeerServer} = require("peer");

const CODE_CHARS = "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ123456789";

module.exports = class VoicePlugin {
  constructor(omegga, config, store) {
    this.omegga = omegga;
    this.config = config;
    this.store = store;

    this.players = [];
    this.lastKnownPlayerPositions = {};
  }

  randomCode(length) {
    let code = "";
    for (let i = 0; i < length; i++)
      code += CODE_CHARS[Math.floor(Math.random() * CODE_CHARS.length)];
    return code;
  }

  async getAllPlayerPositions() {
    const pawnRegExp = /(?<index>\d+)\) BP_PlayerController_C .+?PersistentLevel\.(?<controller>BP_PlayerController_C_\d+)\.Pawn = BP_FigureV2_C'.+?:PersistentLevel.(?<pawn>BP_FigureV2_C_\d+)'$/;
    const posRegExp = /(?<index>\d+)\) CapsuleComponent .+?PersistentLevel\.(?<pawn>BP_FigureV2_C_\d+)\.CollisionCylinder\.RelativeLocation = \(X=(?<x>[\d.-]+),Y=(?<y>[\d.-]+),Z=(?<z>[\d.-]+)\)$/;
    const deadFigureRegExp = /(?<index>\d+)\) BP_FigureV2_C .+?PersistentLevel\.(?<pawn>BP_FigureV2_C_\d+)\.bIsDead = (?<dead>(True|False))$/;

    // wait for the pawn and position watchers to return all the results
    const [ pawns, deadFigures, positions ] = await Promise.all([
      this.omegga.watchLogChunk('GetAll BP_PlayerController_C Pawn', pawnRegExp, {first: 'index'}),
      this.omegga.watchLogChunk('GetAll BP_FigureV2_C bIsDead', deadFigureRegExp, {first: 'index'}),
      this.omegga.watchLogChunk('GetAll SceneComponent RelativeLocation Name=CollisionCylinder', posRegExp, {first: 'index'}),
    ]);

    return pawns
      // iterate through the pawn+controllers
      .map(pawn => ({
      // find the player for the associated controller
        player: this.omegga.getPlayer(pawn.groups.controller),
        // find the position for the associated pawn
        pos: positions.find(pos => pawn.groups.pawn === pos.groups.pawn),
        isDead: deadFigures.find(dead => pawn.groups.pawn === dead.groups.pawn),
        pawn,
      }))
      // filter by only those who have both player and position
      .filter(p => p.player/* && p.pos*/)// <-- we don't actually want to do this, i think this is what's breaking
      // turn the position into a [x, y, z] number array (last 3 items in the array)
      .map(p => ({
        player: p.player,
        pawn: p.pawn.groups.pawn,
        pos: p.pos.slice(3).map(Number),
        isDead: p.isDead && p.isDead.groups.dead === 'True',
      }));
  }

  // thanks cake
  getTransforms() {
    // patterns to match console logs
    const rotRegExp = /(?<index>\d+)\) CapsuleComponent .+?PersistentLevel\.(?<pawn>BP_FigureV2_C_\d+)\.CollisionCylinder\.RelativeRotation = \(Pitch=(?<pitch>[\d\.-]+),Yaw=(?<yaw>[\d\.-]+),Roll=(?<roll>[\d\.-]+)\)$/;
    //const crouchedRegExp = /(?<index>\d+)\) BP_FigureV2_C .+?PersistentLevel\.(?<pawn>BP_FigureV2_C_\d+)\.bIsCrouched = (?<crouched>(True|False))$/;
    //const emotePlayerRegExp = /(?<index>\d+)\) BP_FigureV2_C .+?PersistentLevel\.(?<pawn>BP_FigureV2_C_\d+)\.ActiveEmotes =$/;
    //const emoteStateRegExp = /^\t(?<index>\d+): BlueprintGeneratedClass'(.+)Emotes\/BP_Emote_(?<emote>\w+).\w+'$/;

    // run the pattern commands
    return Promise.all([
      this.getAllPlayerPositions(),
      this.omegga.watchLogChunk('GetAll SceneComponent RelativeRotation Name=CollisionCylinder', rotRegExp, {first: 'index'}),
      //this.omegga.watchLogChunk('GetAll BP_FigureV2_C bIsCrouched', crouchedRegExp, {first: 'index'}),
      //this.omegga.watchLogArray('GetAll BP_FigureV2_C ActiveEmotes', emotePlayerRegExp, emoteStateRegExp),
    ]);
  }

  async sendTransforms() {
    const transforms = [];

    const transformData = await this.getTransforms();

    const players = this.omegga.getPlayers();

    for (const plr of players) {
      let transform = transformData[0].find(t => t.player.name == plr.name);
      if (transform)
        this.lastKnownPlayerPositions[plr.name] = {pos: transform.pos, pawn: transform.pawn, isDead: transform.isDead};
      else {
        const last = this.lastKnownPlayerPositions[plr.name];
        if (!last) continue;

        transform = {player: plr, pos: last.pos, pawn: last.pawn, isDead: last.isDead};
      }

      if (!transform || !transform.pos) continue;

      let rot = transformData[1].find(r => r.groups.pawn == transform.pawn);
      if (rot)
        rot = parseFloat(rot.groups.yaw);
      else
        rot = 0;

      const aplr = this.players.find(p => p.user == transform.player.name);
      const peerId = aplr?.peerId;

      transforms.push({
        name: plr.name,
        x: transform.pos[0],
        y: transform.pos[1],
        z: transform.pos[2],
        yaw: rot,
        peerId,
        isDead: transform.isDead
      });
    }

    this.io.emit("transforms", transforms);
  }

  netConfig() {
    return {
      maxVoiceDistance: this.config["max-distance"] * 10,
      falloffFactor: this.config["falloff-factor"],
      useProximity: this.config["proximity"],
      usePanning: this.config["panning"],
      deadVoice: this.config["voice-when-dead"],
      mapScale: this.config["map-scale"],
      useTTS: this.config["tts"],
      showChat: this.config["show-chat"],
      chatTTS: this.config["tts-chat"],
      othersOnMinimap: this.config["others-on-minimap"],
      deadNonProximity: this.config["dead-non-proximity"]
    };
  }

  async init() {
    const useHttps = this.config["https"];

    // get https working
    // this code is borrowed from the omegga source
    if (useHttps && !require("hasbin").sync("openssl")) {
      console.log("Can't start voice server without openssl installed!");
      return;
    }

    let ssl = {};
    if (useHttps) {
      if (fs.existsSync("./cert.pem")) {
        console.log("Using existing SSL keys");

        ssl = {cert: fs.readFileSync("./cert.pem"), key: fs.readFileSync("./key.pem")};
      } else {
        console.log("Generating new SSL keys");

        const keys = await pem.createCertificate({days: 360, selfSigned: true});
        ssl = {cert: keys.certificate, key: keys.serviceKey};

        // write out
        fs.writeFileSync("./cert.pem", keys.certificate);
        fs.writeFileSync("./key.pem", keys.serviceKey);
      }
    } else {
      console.log("Using HTTP");
    }

    // set up the web server
    this.web = express();
    if (useHttps)
      this.server = https.createServer(ssl, this.web);
    else
      this.server = http.createServer(this.web);
    this.io = io(this.server);

    const server = this.server;
    const peerjsWrapper = {on(event, callback) {
      if (event === 'upgrade') {
        server.on('upgrade', (req, socket, head) => {
          if (!req.url.startsWith('/socket.io/'))
            callback(req, socket, head);
        })
      } else {
        server.on(...arguments);
      }
    }};

    this.peer = ExpressPeerServer(peerjsWrapper);

    this.web.set("trust proxy", 1);

    // serve public folder
    this.web.use("/peerjs", this.peer);
    this.web.use(express.static("plugins/omegga-voice/public"));

    // set up socket io
    this.io.on("connection", (socket) => {
      const code = this.randomCode(6);
      
      // the socket is ready for the server
      socket.on("hi", async (data) => {
        const serverStatus = await this.omegga.getServerStatus();

        // client must link with their user in-game
        socket.emit("hi", {code, serverName: serverStatus.serverName, hostName: this.omegga.host.name, config: this.netConfig()});

        const player = {socket, code, user: null, peerId: data.peerId};
        this.players.push(player);
      });

      socket.on("disconnect", () => {
        // remove this socket from the players array
        for (let i = this.players.length - 1; i >= 0; i--) {
          if (this.players[i].socket == socket) {
            if (this.players[i].user != null) this.omegga.broadcast(`<color="ff0"><b>${this.players[i].user}</></> left the voice chat.`);
            this.io.emit("peer leave", {name: this.players[i].user, peerId: this.players[i].peerId});
            this.players.splice(i, 1);
          }
        }
      });
    });

    // start listening
    this.server.listen(this.config["port"], () => {
      console.log(`Voice chat webserver active at https://localhost:${this.config["port"]}`);
    });

    // start sending transforms regularly
    this.transformInterval = setInterval(async () => {
      await this.sendTransforms();
    }, this.config["polling-rate"]);

    // when a player leaves, clean them up and inform all other clients
    this.omegga.on("leave", async (player) => {
      for (let i = this.players.length - 1; i >= 0; i--) {
        if (this.players[i].user == player.name) {
          this.omegga.broadcast(`<color="ff0"><b>${player.name}</></> left the voice chat.`);
          this.players[i].socket.emit("bye");
          this.io.emit("peer leave", {name: player.name, peerId: this.players[i].peerId});
          this.players.splice(i, 1);
        }
      }
    });

    this.omegga.on("cmd:auth", async (user, code) => {
      for (const player of this.players) {
        if (player.code == code && player.user == null) {
          // found a working player code, attach it
          player.user = user;
          this.omegga.whisper(user, "<color=\"ff0\">Authentication successful. Please refocus your browser window to finish.</>");
          this.omegga.broadcast(`<color="ff0"><b>${user}</></> joined the voice chat.`);

          // inform our socket
          player.socket.emit("authenticated", user);

          // tell the other sockets that we've got a new player
          this.io.emit("peer join", {name: user, peerId: player.peerId});

          return;
        }
      }

      this.omegga.whisper(user, "<color=\"f00\">Invalid authentication code.</>");
    });

    this.omegga.on("chat", async (name, message) => {
      if (this.config["show-chat"] || this.config["tts-chat"]) {
        this.io.emit("chat", {name, message});
      }
    });

    return {registeredCommands: ["auth"]};
  }

  async stop() {
    // tell our clients to refresh their page
    this.io.emit("bye");
  }
}
