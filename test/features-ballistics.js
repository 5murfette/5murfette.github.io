/* Shared by preview, live shots and CPU simulation; no remote dependencies. */
window.BB_BALLISTICS = (() => {
  const speed = 3600, gravity = 260, range = 2100, penetration = 7;
  function point(origin, direction, distance) {
    const t = distance / speed;
    return {x:origin.x + direction.x * distance,y:origin.y + direction.y * distance + .5 * gravity * t * t};
  }
  function aimRate(hit) { return hit.hit ? Math.max(.025, Math.min(1.5, 32 / Math.max(22, hit.distance))) : 1.5; }
  function steer(p, dt, target, worldGravity, wind) {
    p.launchSpeed ||= Math.max(700, Math.hypot(p.vx,p.vy));
    p.lockDelay ??= Math.max(.8, Math.min(1.8, Math.hypot(target.x-p.x,target.y-p.y) / p.launchSpeed * .5));
    if (p.age < p.lockDelay) {p.vy += worldGravity * .3 * dt;p.vx += wind * .25 * dt;return;}
    p.fuel -= dt;
    const want=Math.atan2(target.y-p.y,target.x-p.x),cur=Math.atan2(p.vy,p.vx);
    const delta=Math.atan2(Math.sin(want-cur),Math.cos(want-cur)),blend=Math.min(1,(p.age-p.lockDelay)/1.2);
    const turn=Math.max(-1.2*blend*dt,Math.min(1.2*blend*dt,delta)),angle=cur+turn;
    const velocity=Math.min(1100,Math.max(p.launchSpeed,Math.hypot(p.vx,p.vy))+100*dt);
    p.vx=Math.cos(angle)*velocity;p.vy=Math.sin(angle)*velocity+worldGravity*.08*dt;
  }
  return {speed,gravity,range,penetration,point,aimRate,steer};
})();
