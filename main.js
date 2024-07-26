"use strict";

const ONE_OVER_SQRT_OF_TWO = 1.0 / Math.sqrt(2.0);
const TARGET_FRAME_RATE = 60.0; // frames per second
const TARGET_FRAME_DURATION = 1000.0 / TARGET_FRAME_RATE; // milliseconds

const TILE_SIZE = 16;
const SCREEN_WIDTH = 320;
const SCREEN_HEIGHT = 180;

let gl;
let buffer_unit_rect;
let buffer_debug;
let buffer_debug_length;

let ldtk_map;
let img_spritesheet;
let fb;
let shader_programs = {};
let spritesheet_json;
const entity_data = {};
const entity_instances = [];

let prev_timestamp = 0;
let time_since_last_draw = 0;

let player;
let player_sprite_x, player_sprite_y;
const PLAYER_LOW_SPEED = 0.5;
const PLAYER_HIGH_SPEED = 1.5;
let player_velocity = 0;
let player_velocity_target = 0;
const PLAYER_VELOCITY_MAX_INCREMENT = .1;
const PLAYER_VELOCITY_MAX_DECREMENT = .05;
let player_light_sensors;
let player_shadow_level;
let is_pressed_up = false;
let is_pressed_left = false;
let is_pressed_down = false;
let is_pressed_right = false;
let is_debug_vis = false;

class Rect {
  constructor(x, y, w, h) {
    this.x = x;
    this.y = y;
    this.w = w;
    this.h = h;
  }
  copy() {
    return new Rect(this.x, this.y, this.w, this.h);
  }
  test(o) {
    return !(
      this.x > o.x + o.w ||
      this.y > o.y + o.h ||
      this.x + this.w < o.x ||
      this.y + this.h < o.y
    );
  }
  xDistTo(o, epsilon) {
    let a = this;
    let b = o;
    let flip = 1;
    if (b.x < a.x) [a, b, flip] = [b, a, -1];
    return flip * (b.x - (a.x + a.w) - epsilon);
  }
  yDistTo(o, epsilon) {
    let a = this;
    let b = o;
    let flip = 1;
    if (b.y < a.y) [a, b, flip] = [b, a, -1];
    return flip * (b.y - (a.y + a.h) - epsilon);
  }
}

class Entity {
  constructor(identifier, x, y, data) {
    this.identifier = identifier;
    this._x = x;
    this._y = y;
    this.data = data;
    this.shadowPolygon = polygonFromArray(x, y, data.getShadowBoundingPolygon());
    this.rect = new Rect(x + data.lsBox.x, y + data.lsBox.y, data.lsBox.w, data.lsBox.h);
    this._state = "Static";
    this.facing = "Down";
    this.animStartTime = 0;
  }

  get x() {
    return this._x;
  }
  set x(value) {
    this._x = value;
    this.rect.x = value + this.data.lsBox.x;
    this.shadowPolygon.pos.x = value;
  }
  get y() {
    return this._y;
  }
  set y(value) {
    this._y = value;
    this.rect.y = value + this.data.lsBox.y;
    this.shadowPolygon.pos.y = value;
  }
  get state() {
    return this._state;
  }
  setState(s, t) {
    if (this._state !== s) {
      this.animStartTime = t
    }
    this._state = s;
  }

  getFrame(t) {
    return this.data.animations[this.state][this.facing].getFrame(t - this.animStartTime);
  }
}

// TODO
// parameters: facing, animation, time
// const animations = {
//   walk: { down: [frame1, frame2, ... ], right: [ ...
//   idle: { ...
// }
// const frame = {
//   duration: number
//   srcRect: Rect
//   ssSrcRect: Rect
//   ssOffsetX: number
//   ssOffsetY: number
// }

class Frame {
  constructor(x, y, w, h, duration) {
    this.srcRect = new Rect(x, y, w, h);
    this.duration = duration ?? 1;
    console.assert(this.duration > 0);

    // optional
    this.ssSrcRect = new Rect(0, 0, 0, 0);
    this.ssOffsetX = 0;
    this.ssOffsetY = 0;
  }

  static fromJSON(json, ssJSON) {
    const frame = new Frame(
      json.frame.x, json.frame.y, json.frame.w, json.frame.h, json.duration);
    frame.ssSrcRect = new Rect(
      ssJSON.frame.x,
      ssJSON.frame.y,
      ssJSON.frame.w,
      ssJSON.frame.h);
    frame.ssOffsetX = ssJSON.spriteSourceSize.x - json.spriteSourceSize.x;
    frame.ssOffsetY = ssJSON.spriteSourceSize.y - json.spriteSourceSize.y;
    return frame;
  }
}

// invariant: always has at least one frame
class Animation {
  constructor(frames) {
    console.assert(frames && frames.length > 0);
    this.loop = true;
    this.frames = frames;
    this.totalDuration = this.frames.map(f => f.duration).reduce((a, b) => a + b);
  }
  get height() {
    return this.frames[0].srcRect.h;
  }
  getFrame(t) {
    let timeInAnim = t % this.totalDuration;
    for (const frame of this.frames) {
      if (timeInAnim > frame.duration) {
        timeInAnim -= frame.duration;
      } else {
        return frame;
      }
    }
    console.assert(false); // should not be reached
  }
}

class EntityData {
  constructor() {
    // animations
    // - object. primary key: animation name, secondary key: facing
    // - should always have "Static" animation with "Down" facing
    this.animations = {};
    // base_rect
    // - relative to BOTTOM LEFT corner of the sprite AND base_rect
    // - coordinates are tiles, not pixels
    // - will flip Y when transforming to world position
    this.base_rect = new Rect(0, 0, 0, 0);
    // bounding_polygon
    // - format: [x_0, y_0, x_1, y_1, ... x_n, y_n]
    // - coordinates are tiles, not pixels
    // - vertices clockwise around the perimeter of the sprite
    // - (0, 0) is BOTTOM LEFT corner of the sprite
    // - will flip Y when transforming to world position
    this.bounding_polygon = [];
  }

  addAnimation(name, facing, animation) {
    if (!(name in this.animations)) this.animations[name] = {};
    this.animations[name][facing] = animation;
  }

  setStaticFrame(frame) {
    this.addAnimation("Static", "Down", new Animation([frame]));
  }

  getStaticFrame() {
    return this.animations["Static"]["Down"].frames[0];
  }

  getSpriteHeight() {
    return this.animations["Static"]["Down"].height;
  }

  getBoundingPolygon() {
    let result = [];
    for (let i = 0; i < this.bounding_polygon.length; i += 2) {
      const x = this.bounding_polygon[i];
      const y = this.bounding_polygon[i+1];
      result.push(TILE_SIZE * x);
      result.push(this.getSpriteHeight() - TILE_SIZE * y);
    }
    return result;
  }

  get lsBox() {
    if (this._lsBox) return this._lsBox;
    const x = TILE_SIZE * this.base_rect.x;
    const y = this.getSpriteHeight() - TILE_SIZE * (this.base_rect.y + this.base_rect.h);
    const w = TILE_SIZE * this.base_rect.w;
    const h = TILE_SIZE * this.base_rect.h;
    this._lsBox = new Rect(x, y, w, h);
    Object.freeze(this._lsBox);
    return this._lsBox;
  }

  getShadowBoundingPolygon() {
    const vertices = this.getBoundingPolygon();
    const base_rect = this.lsBox;
    const base_center_x = base_rect.x + 0.5 * base_rect.w;
    const base_center_y = base_rect.y + 0.5 * base_rect.h;
    const shadow_vertices = Array(vertices.length);
    for (let i = 0; i < vertices.length; i += 2) {
      const x = vertices[i];
      const y = vertices[i+1];
      const [scaled_x, scaled_y] =
        scalePoint(x, y, base_center_x, base_center_y, -1);
      shadow_vertices[i] = scaled_x;
      shadow_vertices[i+1] = scaled_y;
    }
    return shadow_vertices;
  }
}

window.addEventListener("load", main);

/**
 * keycodes:
 * w 87
 * a 65
 * s 83
 * d 68
 * space 32
 * e 69
 * q 81
 */

document.onkeydown = function (e) {
  switch (e.keyCode) {
    case 38: // up arrow
    case 87: // w
    is_pressed_up = true;
    break;
    case 37: // left arrow
    case 65: // a
    is_pressed_left = true;
    break;
    case 40: // down arrow
    case 83: // s
    is_pressed_down = true;
    break;
    case 39: // right arrow
    case 68: // d
    is_pressed_right = true;
    break;
    case 80: // p
    is_debug_vis = !is_debug_vis;
    break;
  }
};

document.onkeyup = function (e) {
  switch (e.keyCode) {
    case 38: // up arrow
    case 87: // w
    is_pressed_up = false;
    break;
    case 37: // left arrow
    case 65: // a
    is_pressed_left = false;
    break;
    case 40: // down arrow
    case 83: // s
    is_pressed_down = false;
    break;
    case 39: // right arrow
    case 68: // d
    is_pressed_right = false;
    break;
  }
};

async function main() {
  let promises = [];

  img_spritesheet = new Image();
  img_spritesheet.src = "assets/spritesheet2.png";
  promises.push(new Promise(resolve => {
    img_spritesheet.onload = function() {
      resolve();
    };
  }));

  promises.push(
    fetch("assets/map2.ldtk")
    .then(response => response.json())
  );

  promises.push(
    fetch("assets/spritesheet2.json")
    .then(response => response.json())
  );

  let assets = await Promise.all(promises);

  ldtk_map = assets[1];
  spritesheet_json = assets[2];

  // --- INIT WEBGL ---
  let canvas = document.querySelector("#canvas");
  gl = canvas.getContext("webgl2");
  if (!gl) {
    console.error("couldn't obtain webgl2 context");
    return;
  }

  gl.enable(gl.BLEND);
  gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA);

  let texture = gl.createTexture();
  gl.activeTexture(gl.TEXTURE0);
  gl.bindTexture(gl.TEXTURE_2D, texture);
  gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false);
  gl.texImage2D(gl.TEXTURE_2D,
    0,
    gl.RGBA,
    gl.RGBA,
    gl.UNSIGNED_BYTE,
    img_spritesheet);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);

  let tex_shadow_map = gl.createTexture();
  gl.activeTexture(gl.TEXTURE1);
  gl.bindTexture(gl.TEXTURE_2D, tex_shadow_map);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
  gl.texImage2D(gl.TEXTURE_2D,
      0,
      gl.RGBA,
      gl.drawingBufferWidth,
      gl.drawingBufferHeight,
      0,
      gl.RGBA,
      gl.UNSIGNED_BYTE,
      null);

  // --- SET UP FRAMEBUFFER (for render to texture) ---

  fb = gl.createFramebuffer();
  gl.bindFramebuffer(gl.DRAW_FRAMEBUFFER, fb);
  gl.framebufferTexture2D(gl.DRAW_FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D,
    tex_shadow_map, 0);

  gl.drawBuffers([gl.COLOR_ATTACHMENT0]);

  {
    let status = gl.checkFramebufferStatus(gl.DRAW_FRAMEBUFFER);
    if (status != gl.FRAMEBUFFER_COMPLETE) {
        console.error(status.toString(16));
        return;
    }
  }

  gl.bindFramebuffer(gl.DRAW_FRAMEBUFFER, null);

  // --- COMPILE SHADERS ---

  let vs_tiles = document.querySelector("#vs_tiles").innerHTML.trim();
  let fs_tiles = document.querySelector("#fs_tiles").innerHTML.trim();
  shader_programs.tiles = createProgram(gl, vs_tiles, fs_tiles);

  let vs_tiles_mask = document.querySelector("#vs_tiles_mask").innerHTML.trim();
  let fs_tiles_mask = document.querySelector("#fs_tiles_mask").innerHTML.trim();
  shader_programs.tiles_mask = createProgram(gl, vs_tiles_mask, fs_tiles_mask);

  let vs_shadow = document.querySelector("#vs_shadow").innerHTML.trim();
  let fs_shadow = document.querySelector("#fs_shadow").innerHTML.trim();
  shader_programs.shadow = createProgram(gl, vs_shadow, fs_shadow);

  let vs_pass = document.querySelector("#vs_pass").innerHTML.trim();
  let fs_pass = document.querySelector("#fs_pass").innerHTML.trim();
  shader_programs.pass = createProgram(gl, vs_pass, fs_pass);

  let vs_debug = document.querySelector("#vs_debug").innerHTML.trim();
  let fs_debug = document.querySelector("#fs_debug").innerHTML.trim();
  shader_programs.debug = createProgram(gl, vs_debug, fs_debug);

  // --- LOAD SPRITE DATA ---

  for (const tag of spritesheet_json.meta.frameTags) {
    let [id, animName] = tag.name.split("_");
    if (!animName) animName = "Static";
    if (!(id in entity_data)) {
      const data = new EntityData();
      entity_data[id] = data;
    }
    for (const facing of ["Down", "Right", "Up", "Left"]) {
      const frames = [];
      for (let i = tag.from; i <= tag.to; i++) {
        const key = `${i}_${facing}`;
        const ssKey = `${i}_${facing}_ss`;
        const json = spritesheet_json.frames[key];
        const ssJSON = spritesheet_json.frames[ssKey];
        const frame = Frame.fromJSON(json, ssJSON);
        frames.push(frame);
      }
      entity_data[id].addAnimation(animName, facing, new Animation(frames));
    }
  }

  entity_data["Clocktower"].base_rect = new Rect(0, 0, 2, 2);
  entity_data["Clocktower"].bounding_polygon = [
    0, 0,
    0, 2,
    2, 4,
    4, 5,
    4, 2,
    2, 0,
  ];

  entity_data["House"].base_rect = new Rect(0, 0, 4, 3);
  entity_data["House"].bounding_polygon = [
    0, 0,
    0, 3,
    2, 5,
    5, 6,
    6, 5,
    6, 2,
    4, 0,
  ];

  entity_data["Well"].base_rect = new Rect(0.5, 0.5, 1, 1);
  entity_data["Well"].bounding_polygon = [
    1, 1,
    1, 3,
    3, 4,
    3, 2,
  ];

  entity_data["DebugBlock"].base_rect = new Rect(0, 0, 1, 1);
  entity_data["DebugBlock"].bounding_polygon = [
    0, 0,
    0, 1,
    1, 2,
    2, 2,
    2, 1,
    1, 0,
  ];

  entity_data["Player"].base_rect = new Rect(0.25, 0.25, 0.5, 0.5);
  entity_data["Player"].bounding_polygon = [
    0, 0,
    0, 1,
    1, 2,
    2, 2,
    2, 1,
    1, 0,
  ];

  player_light_sensors = [
     8, 24,
    16, 16,
    24,  8, 
  ];
  player_shadow_level = 0;

  // --- CONSTRUCT GEOMETRY ---

  buffer_unit_rect = gl.createBuffer();
  gl.bindBuffer(gl.ARRAY_BUFFER, buffer_unit_rect);
  gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([
    0, 0,
    1, 0,
    1, 1,
    0, 1,
  ]), gl.STATIC_DRAW);

  {
    buffer_debug = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, buffer_debug);
    const verts = [
      0, 0,
      1, 0,
      1, 1,
      0, 1,
      0, 0,
      1, 1,
      1, 0,
      0, 1,
    ];
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array(verts), gl.STATIC_DRAW);
    buffer_debug_length = verts.length / 2;
  }

  for (const entity_name of Object.keys(entity_data)) {
    const data = entity_data[entity_name];
    const vertices = data.getBoundingPolygon();

    data.num_verts = vertices.length / 2;
    data.bounding_polygon_buffer = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, data.bounding_polygon_buffer);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array(vertices), gl.STATIC_DRAW);

    const base_rect = data.lsBox;
    const base_center_x = base_rect.x + 0.5 * base_rect.w;
    const base_center_y = base_rect.y + 0.5 * base_rect.h;

    const shadow_vertices = Array(vertices.length);
    for (let i = 0; i < vertices.length; i += 2) {
      const x = vertices[i];
      const y = vertices[i+1];
      const [scaled_x, scaled_y] =
        scalePoint(x, y, base_center_x, base_center_y, -1);
      shadow_vertices[i] = scaled_x;
      shadow_vertices[i+1] = scaled_y;
    }

    data.shadow_bounding_polygon_buffer = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, data.shadow_bounding_polygon_buffer);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array(shadow_vertices), gl.STATIC_DRAW);
  }

  // --- SPAWN ENTITIES ---

  for (const level of ldtk_map.levels) {
    for (const layer of level.layerInstances) {
      for (const entity of layer.entityInstances) {
        const inst = new Entity(
          entity.__identifier,
          entity.__worldX,
          entity.__worldY,
          entity_data[entity.__identifier]);
        entity_instances.push(inst);
        if (entity.__identifier === "Player") {
          player = inst;
        }
      }
    }
  }

  // --- SET UP VERTEX ARRAYS ---

  gl.enableVertexAttribArray(0);
  gl.bindBuffer(gl.ARRAY_BUFFER, buffer_unit_rect);
  gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0);

  gl.enableVertexAttribArray(1);
  gl.bindBuffer(gl.ARRAY_BUFFER, buffer_debug);
  gl.vertexAttribPointer(1, 2, gl.FLOAT, false, 0, 0);

  window.requestAnimationFrame(step);
}

// --- HELPERS ---

function createProgram(gl, vs_source, fs_source) {
  const vs = gl.createShader(gl.VERTEX_SHADER);
  gl.shaderSource(vs, vs_source);
  gl.compileShader(vs);
  if (!gl.getShaderParameter(vs, gl.COMPILE_STATUS)) {
    console.error(gl.getShaderInfoLog(vs));
    return;
  }

  const fs = gl.createShader(gl.FRAGMENT_SHADER);
  gl.shaderSource(fs, fs_source);
  gl.compileShader(fs);
  if (!gl.getShaderParameter(fs, gl.COMPILE_STATUS)) {
    console.error(gl.getShaderInfoLog(fs));
    return;
  }

  let program = gl.createProgram();
  gl.attachShader(program, vs);
  gl.attachShader(program, fs);
  gl.linkProgram(program);
  gl.detachShader(program, vs);
  gl.detachShader(program, fs);
  gl.deleteShader(vs);
  gl.deleteShader(fs);
  if (!gl.getProgramParameter(program, gl.LINK_STATUS)) {
    console.error(gl.getProgramInfoLog(program));
    return;
  }

  return program;
}

function step(timestamp) {
  const dt = timestamp - prev_timestamp;
  prev_timestamp = timestamp;
  time_since_last_draw += dt;
  if (time_since_last_draw >= TARGET_FRAME_DURATION) {
    time_since_last_draw %= TARGET_FRAME_DURATION;
    update(timestamp);
    render(timestamp);
  }
  window.requestAnimationFrame(step);
}

function update(timestamp) {
  player_velocity_target = lerp(
    PLAYER_LOW_SPEED,
    PLAYER_HIGH_SPEED,
    2 * player_shadow_level / player_light_sensors.length);

  if (player_velocity < player_velocity_target) {
    const diff =  player_velocity_target - player_velocity;
    player_velocity += Math.min(diff, PLAYER_VELOCITY_MAX_INCREMENT);
  } else {
    const diff = player_velocity - player_velocity_target;
    player_velocity -= Math.min(diff, PLAYER_VELOCITY_MAX_DECREMENT);
  }

  let dx = 0;
  let dy = 0;
  if (is_pressed_right) {
    dx += player_velocity;
  }
  if (is_pressed_left) {
    dx -= player_velocity;
  }
  if (is_pressed_up) {
    dy -= player_velocity;
  }
  if (is_pressed_down) {
    dy += player_velocity;
  }

  if (dx !== 0 || dy !== 0) {
    player.setState("Walk", timestamp);
  } else {
    player.setState("Idle", timestamp);
  }

  if (dx > 0) {
    player.facing = "Right";
  } else if (dx < 0) {
    player.facing = "Left";
  }

  if (dy > 0) {
    player.facing = "Down";
  } else if (dy < 0) {
    player.facing = "Up";
  }

  const rectCopy = player.rect.copy();
  const oldPlayerX = player.x;
  const oldPlayerY = player.y;

  player.x += dx;
  for (const entity of entity_instances) {
    if (entity.identifier === "Player") continue;
    if (player.rect.test(entity.rect)) {
      player.x = oldPlayerX + rectCopy.xDistTo(entity.rect, 1e-12);
    }
  }

  player.y += dy;
  for (const entity of entity_instances) {
    if (entity.identifier === "Player") continue;
    if (player.rect.test(entity.rect)) {
      player.y = oldPlayerY + rectCopy.yDistTo(entity.rect, 1e-12);
    }
  }

  // --- calculate shadow level ---
  {
    let shadow_level = 0;
    forEachPair(player_light_sensors, (x, y) => {
      const point = new SAT.Vector(player.x + x, player.y + y);
      for (const entity of entity_instances) {
        if (entity.identifier === "Player") continue;
        const polygon = entity.shadowPolygon;
        if (!polygon) continue;
        if (SAT.pointInPolygon(point, polygon)) {
          shadow_level++;
          return;
        }
      }
    });
    player_shadow_level = shadow_level;
  }
}

function render(timestamp) {
  // --- build shadow map ---
  {
    gl.bindFramebuffer(gl.DRAW_FRAMEBUFFER, fb);

    gl.clearColor(0.0, 0.0, 0.0, 0.0);
    gl.clear(gl.COLOR_BUFFER_BIT);

    gl.useProgram(shader_programs.shadow);

    let u_tex = gl.getUniformLocation(shader_programs.shadow, "tex");
    let u_texSize = gl.getUniformLocation(shader_programs.shadow, "texSize");
    let u_screenSize = gl.getUniformLocation(shader_programs.shadow, "screenSize");
    let u_srcRect = gl.getUniformLocation(shader_programs.shadow, "srcRect");
    let u_dstRect = gl.getUniformLocation(shader_programs.shadow, "dstRect");
    let u_origin = gl.getUniformLocation(shader_programs.shadow, "origin");
    let u_cameraPos = gl.getUniformLocation(shader_programs.shadow, "cameraPos");

    gl.uniform1i(u_tex, 0);
    gl.uniform2f(u_texSize, img_spritesheet.width, img_spritesheet.height);
    gl.uniform2f(u_screenSize, SCREEN_WIDTH, SCREEN_HEIGHT);
    const [cx, cy] = getCameraPosition();
    gl.uniform2f(u_cameraPos, (cx), (cy));

    for (const entity of entity_instances) {
      const base = Object.assign({}, entity.data.lsBox);
      base.x += entity.x;
      base.y += entity.y;
      const base_center_x = (2 * base.x + base.w) / 2.0;
      const base_center_y = (2 * base.y + base.h) / 2.0;
      const rect = entity.getFrame(timestamp).srcRect;
      gl.uniform4f(u_srcRect, rect.x, rect.y, rect.w, rect.h);
      gl.uniform4f(u_dstRect, entity.x, entity.y, rect.w, rect.h);
      gl.uniform2f(u_origin, base_center_x, base_center_y);
      gl.drawArrays(gl.TRIANGLE_FAN, 0, 4);
    }

    // --- subtract entities and add self-shadow ---
    {
      gl.useProgram(shader_programs.tiles_mask);

      let u_tex = gl.getUniformLocation(shader_programs.tiles_mask, "tex");
      let u_texSize = gl.getUniformLocation(shader_programs.tiles_mask, "texSize");
      let u_screenSize = gl.getUniformLocation(shader_programs.tiles_mask, "screenSize");
      let u_srcRect = gl.getUniformLocation(shader_programs.tiles_mask, "srcRect");
      let u_dstRect = gl.getUniformLocation(shader_programs.tiles_mask, "dstRect");
      let u_cameraPos = gl.getUniformLocation(shader_programs.tiles_mask, "cameraPos");

      gl.blendEquation(gl.FUNC_REVERSE_SUBTRACT);
      gl.blendFunc(gl.ONE, gl.ONE);

      gl.uniform1i(u_tex, 0);
      gl.uniform2f(u_texSize, img_spritesheet.width, img_spritesheet.height);
      gl.uniform2f(u_screenSize, SCREEN_WIDTH, SCREEN_HEIGHT);
      const [cx, cy] = getCameraPosition();
      gl.uniform2f(u_cameraPos, (cx), (cy));

      // subtract entities
      for (const entity of entity_instances) {
        if (entity.identifier === "Player") continue;
        const rect = entity.data.getStaticFrame().srcRect;
        gl.uniform4f(u_srcRect, rect.x, rect.y, rect.w, rect.h);
        gl.uniform4f(u_dstRect, entity.x, entity.y, rect.w, rect.h);
        gl.drawArrays(gl.TRIANGLE_FAN, 0, 4);
      }

      // return to default blend function
      gl.blendEquation(gl.FUNC_ADD);
      gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA);

      // add entity self-shadow
      for (const entity of entity_instances) {
        const frame = entity.data.getStaticFrame();
        const rect = frame.ssSrcRect;
        gl.uniform4f(u_srcRect, rect.x, rect.y, rect.w, rect.h);
        gl.uniform4f(u_dstRect, entity.x + frame.ssOffsetX, entity.y + frame.ssOffsetY, rect.w, rect.h);
        gl.drawArrays(gl.TRIANGLE_FAN, 0, 4);
      }

    }
  }

  // --- main pass ---
  {
    gl.bindFramebuffer(gl.DRAW_FRAMEBUFFER, null);

    gl.clearColor(0.7, 0.7, 0.7, 1.0);
    gl.clear(gl.COLOR_BUFFER_BIT);

    // --- render tiles ---
    {
      gl.useProgram(shader_programs.tiles);

      let u_tex = gl.getUniformLocation(shader_programs.tiles, "tex");
      let u_texSize = gl.getUniformLocation(shader_programs.tiles, "texSize");
      let u_screenSize = gl.getUniformLocation(shader_programs.tiles, "screenSize");
      let u_srcRect = gl.getUniformLocation(shader_programs.tiles, "srcRect");
      let u_dstRect = gl.getUniformLocation(shader_programs.tiles, "dstRect");
      let u_cameraPos = gl.getUniformLocation(shader_programs.tiles, "cameraPos");

      gl.uniform1i(u_tex, 0);
      gl.uniform2f(u_texSize, img_spritesheet.width, img_spritesheet.height);
      gl.uniform2f(u_screenSize, SCREEN_WIDTH, SCREEN_HEIGHT);
      const [cx, cy] = getCameraPosition();
      gl.uniform2f(u_cameraPos, (cx), (cy));

      for (const level of ldtk_map.levels) {
        for (const layer of level.layerInstances) {
          for (const tile of layer.gridTiles) {
            gl.uniform4f(u_srcRect,
              tile.src[0], tile.src[1], layer.__cWid, layer.__cHei);
            gl.uniform4f(u_dstRect,
              tile.px[0] + layer.__pxTotalOffsetX, tile.px[1] + layer.__pxTotalOffsetY, layer.__cWid, layer.__cHei);
            gl.drawArrays(gl.TRIANGLE_FAN, 0, 4);
          }
        }
      }
    }

    // --- render entities ---
    {
      gl.useProgram(shader_programs.tiles);

      let u_tex = gl.getUniformLocation(shader_programs.tiles, "tex");
      let u_texSize = gl.getUniformLocation(shader_programs.tiles, "texSize");
      let u_screenSize = gl.getUniformLocation(shader_programs.tiles, "screenSize");
      let u_srcRect = gl.getUniformLocation(shader_programs.tiles, "srcRect");
      let u_dstRect = gl.getUniformLocation(shader_programs.tiles, "dstRect");
      let u_cameraPos = gl.getUniformLocation(shader_programs.tiles, "cameraPos");

      gl.uniform1i(u_tex, 0);
      gl.uniform2f(u_texSize, img_spritesheet.width, img_spritesheet.height);
      gl.uniform2f(u_screenSize, SCREEN_WIDTH, SCREEN_HEIGHT);
      const [cx, cy] = getCameraPosition();
      gl.uniform2f(u_cameraPos, (cx), (cy));

      for (const entity of entity_instances) {
        const rect = entity.getFrame(timestamp).srcRect;
        gl.uniform4f(u_srcRect, rect.x, rect.y, rect.w, rect.h);
        gl.uniform4f(u_dstRect, entity.x, entity.y, rect.w, rect.h);
        gl.drawArrays(gl.TRIANGLE_FAN, 0, 4);
      }
    }

    // --- render shadow map texture to screen ---
    {
      /**
       * custom blend function for color inversion:
       *
       *   finalColor = (1 - dstColor) * srcColor + (1 - srcAlpha) * dstColor
       *
       * for shadow map texel (1, 1, 1, 1), finalColor => (1 - dstColor)
       * for shadow map texel (0, 0, 0, 0), finalColor => dstColor
       */
      gl.blendEquation(gl.FUNC_ADD);
      gl.blendFuncSeparate(
        gl.ONE_MINUS_DST_COLOR, gl.ONE_MINUS_SRC_ALPHA,
        gl.ZERO, gl.ONE);
      gl.useProgram(shader_programs.pass);
      let u_tex = gl.getUniformLocation(shader_programs.pass, "tex");
      gl.uniform1i(u_tex, 1);
      gl.drawArrays(gl.TRIANGLE_FAN, 0, 4);

      // return to default blend function
      gl.blendEquation(gl.FUNC_ADD);
      gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA);
    }


    // --- render debug collision ---
    if (is_debug_vis) {
      gl.useProgram(shader_programs.debug);

      let u_screenSize = gl.getUniformLocation(shader_programs.debug, "screenSize");
      let u_cameraPos = gl.getUniformLocation(shader_programs.debug, "cameraPos");
      let u_worldPos = gl.getUniformLocation(shader_programs.debug, "worldPos");
      let u_debugColor = gl.getUniformLocation(shader_programs.debug, "debugColor");
      let u_scale = gl.getUniformLocation(shader_programs.debug, "scale");

      gl.uniform2f(u_screenSize, SCREEN_WIDTH, SCREEN_HEIGHT);
      const [cx, cy] = getCameraPosition();
      gl.uniform2f(u_cameraPos, (cx), (cy));
      gl.uniform2f(u_scale, 1, 1);

      for (const entity of entity_instances) {
        // --- draw bounding polygon ---
        gl.uniform3f(u_debugColor, 1, 0, 0);
        gl.bindBuffer(gl.ARRAY_BUFFER, entity.data.bounding_polygon_buffer);
        gl.vertexAttribPointer(1, 2, gl.FLOAT, false, 0, 0);
        gl.uniform2f(u_worldPos, entity.x, entity.y);
        gl.drawArrays(gl.LINE_LOOP, 0, entity.data.num_verts);

        // --- draw shadow bounding polygon ---
        gl.uniform3f(u_debugColor, 0, 1, 0);
        gl.bindBuffer(gl.ARRAY_BUFFER, entity.data.shadow_bounding_polygon_buffer);
        gl.vertexAttribPointer(1, 2, gl.FLOAT, false, 0, 0);
        gl.uniform2f(u_worldPos,
          entity.shadowPolygon.pos.x,
          entity.shadowPolygon.pos.y);
        gl.drawArrays(gl.LINE_LOOP, 0, entity.data.num_verts);
      }

      // --- draw entity bases ---
      gl.bindBuffer(gl.ARRAY_BUFFER, buffer_debug);
      gl.vertexAttribPointer(1, 2, gl.FLOAT, false, 0, 0);
      gl.uniform3f(u_debugColor, 0, 1, 1);

      for (const entity of entity_instances) {
        gl.uniform2f(u_scale, entity.rect.w, entity.rect.h);
        gl.uniform2f(u_worldPos, entity.rect.x, entity.rect.y);
        gl.drawArrays(gl.LINE_STRIP, 0, buffer_debug_length);
      }
    }

    // update debug read-out
    {
      const shadow_level_span = document.getElementById("shadowLevel");
      const total = player_light_sensors.length / 2.0;
      const meter = [];
      for (let i = 0; i < total; i++) {
        if (i < player_shadow_level) meter.push("#");
        else meter.push("-");
      }
      const result = meter.join("");
      if (shadow_level_span.innerHTML !== result) {
        shadow_level_span.innerHTML = result;
      }
    }
    {
      const span = document.getElementById("playerSpeed");
      span.innerHTML = player_velocity.toPrecision(2);
    }
    {
      const span = document.getElementById("playerState");
      span.innerHTML = player.state;
    }
  }
}

function getCameraPosition() {
  return [
    player.x + 3 * TILE_SIZE - 0.5 * SCREEN_WIDTH,
    player.y - 0.5 * SCREEN_HEIGHT,
  ];
}

function scalePoint(x, y, origin_x, origin_y, scale) {
  return [
    (x - origin_x) * scale + origin_x,
    (y - origin_y) * scale + origin_y,
  ];
}

function forEachPair(arr, f) {
  for (let i = 0; i < arr.length - 1; i += 2) {
    const x = arr[i];
    const y = arr[i+1];
    f(x, y);
  }
}

function polygonFromArray(x, y, arr) {
  const points = [];
  forEachPair(arr, (x, y) => {
    points.push(new SAT.Vector(x, y));
  });
  return new SAT.Polygon(new SAT.Vector(x, y), points);
}

function lerp(a, b, pct) {
  return a * (1 - pct) + b * pct;
}
