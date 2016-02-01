"use strict";
const md5 = require("blueimp-md5")
    , _ = require("lodash");

const { Vec2, Circle, Rect } = require("../shared/math")
    , io = require("./server");

/**
 * Body showed on board
 * @class
 */
class BoardBody {
  constructor(circle, v) {
    this.circle = circle;
    this.v = v || new Vec2;
  }
}

/**
 * Room class
 * @class
 */
class Room {
  constructor(name, admin, maxPlayers, password, hidden) {
    this.name = name;
    this.maxPlayers = maxPlayers || 2;
    this.password =  md5(password);

    // Players
    this.players = [];
    this.admin = this.join(admin);

    // Ball is separated object
    this.ball = {
      body: new BoardBody(new Circle(32, 32, 13))
    };
    this.board = new Rect(0, 0, 400, 400);

    // hide room in rooms list
    if(hidden !== true)
      (Room.list = Room.list || []).push(this);
  }

  /**
   * Get teams with players nicks
   */
  get teamsHeaders() {
    return _
      .chain(this.players)
      .groupBy("team")
      .mapValues(_.partial(_.map, _, "nick"))
      .value();
  }

  /**
   * Returns true if passwords matches
   * @param password  Password in plain text
   * @returns {boolean}
   */
  checkPassword(password) {
    return md5(password) === this.password;
  }

  /**
   * Returns true if server is full
   * @returns {boolean}
   */
  isFull() {
    return this.maxPlayers <= this.players.length;
  }

  /**
   * Returns true is room is locked
   * @returns {boolean}
   */
  isLocked() {
    return this.password !== "d41d8cd98f00b204e9800998ecf8427e";
  }

  /**
   * Kick player from room
   * @param player  Player
   * @returns {Room}
   */
  kick(player) {
    player
      .socket
      .emit("roomKick", "You are kicked!")
      .leave(this.name);
    this.leave(player);
    return this;
  }

  /**
   * Get list of all players from all teams without omit
   * @param omit  Omit team name
   * @returns Players
   */
  omitTeam(omit) {
    return _.filter(this.players, player => player.team !== omit);
  }

  /**
   * Destroy room
   */
  destroy() {
    // Stop interval
    this.stop();

    // Kick all players ;)
    _.each(this.players, this.kick.bind(this));
    _.remove(Room.list, this);
    return this;
  }

  /**
   * Check room collisions
   * @param players Players array
   * @param index   Player index
   * @private
   */
  static checkCollisions(players, index) {
    let p1 = players[index].body
      , c1 = p1.circle.center;

    for (let i = 0; i < players.length; ++i) {
      if(i === index)
        continue;

      // Get center of circle
      let p2 = players[i].body
        , c2 = p2.circle.center;

      // If the circles are colliding
      if(p1.circle.intersect(p2.circle)) {
        let dist = p2.circle.distance(p1.circle);
        p2.v.x += (c2.x - c1.x) / dist;
        p2.v.y += (c2.y - c1.y) / dist;
        p2.circle.add(p2.v);
      }
    }
  }

  /**
   * Update physics in loop
   * @private
   */
  _updatePhysics() {
    let cachedPlayers = this.omitTeam(Room.Teams.SPECTATORS);
    cachedPlayers.push(...[
      this.ball
    ]);

    // Socket data [x, y, r, flag, v.x, v.y]
    let packSize = 6
      , socketData = new Float32Array(cachedPlayers.length * packSize);

    _.each(cachedPlayers, (player, index) => {
      // Check collisions
      if(index !== cachedPlayers.length - 1)
        Room.checkCollisions(cachedPlayers, index);

      // Update physics
      player.body.circle.add(player.body.v);
      player.body.v.xy = [
          player.body.v.x * .95
        , player.body.v.y * .95
      ];

      // Data structure: 00000BRR
      let flags = player.team | (index === cachedPlayers.length - 1 && 1 << 2);
      socketData.set([
        /** position */
          player.body.circle.x
        , player.body.circle.y
        , player.body.circle.r
        , flags /** todo: More flags */

        /** velocity */
        , player.body.v.x
        , player.body.v.y
      ], index * packSize)
    });

    // Broadcast
    this.broadcast("roomUpdate", socketData.buffer);
  }

  /**
   * Start/stop room loop
   */
  start() {
    this.physicsInterval && this.stop();
    this.physicsInterval = setInterval(this._updatePhysics.bind(this), 1000 / 60);
  }
  stop() {
    clearInterval(this.physicsInterval);
  }

  /**
   * Set player team
   * @param player    player
   * @param newTeam   New team
   * @returns {Room}
   */
  setTeam(player, newTeam) {
    player.team = newTeam;
    this._broadcastSettings();
    return this;
  }

  /**
   * Broadcast to all sockets connected to room
   * @param arguments Broadcast arguments
   * @returns {Room}
   */
  broadcast() {
    let obj = io.sockets.in(this.name);
    obj && obj.emit.apply(obj, arguments);
    return this;
  }

  /**
   * Send room settings to all player socket
   * @param socket  Socket
   * @returns {Room}
   * @private
   */
  _broadcastSettings(socket) {
    let data = {
        teams: this.teamsHeaders
      , board: this.board
    };
    (socket ? socket.emit.bind(socket) : this.broadcast.bind(this))("roomSettings", data);
    return this;
  }

  /**
   * Join to room
   * @param player  Player
   * @returns {Room}
   */
  join(player) {
    // Adding to list
    _.assign(player, {
        team: Room.Teams.SPECTATORS
      , room: this
      , body: new BoardBody(new Circle(0, 0, 13))
    });

    // Join socket
    player.socket.join(this.name);
    this.players.push(player);

    // Broadcast to except player
    player.socket.broadcast
      .to(this.name)
      .emit("roomPlayerJoin", _.pick(player, ["nick", "team"]));

    // Send list of players to player
    this._broadcastSettings(player.socket);
    return player;
  }

  /**
   * Leave player from room
   * @param player  Player
   * @returns {Room}
   */
  leave(player) {
    if(!player.team)
      return;

    // Leave
    this.broadcast("roomPlayerLeave", _.pick(player, "team", "nick"));

    // Reset variables for future room
    player.room = player.team = player.body = null;

    _.remove(this.players, player);
    this.admin === player && this.destroy();
    return this;
  }

  /**
   * Return list of rooms
   * @returns {Array}
   */
  static headers() {
    return _.map(Room.list, room => {
      return {
          name: room.name
        , password: room.isLocked() ? "yes" : "no"
        , players: room.players.length + "/" + room.maxPlayers
      };
    });
  }
}

/** Team codes */
Room.Teams = {
    LEFT: 0
  , SPECTATORS: 1
  , RIGHT: 2
};

/** Export modules */
module.exports = {
  Room: Room
};