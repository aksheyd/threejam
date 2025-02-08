Transfomrations:
- euler angles lead to Gimbal Lock (use arbitrary vector)
- scale then rotate then translate vectors using matricies
	- WHICH IS IN REVERSE IN CALCS (so glm::trans then rotate then scale)

- GLSL allows for GLM mat4 class

Coordinate System:
- change coordinates from:
	1. local space -> like blender model
	2. world space -> bring blender model into unity and place
	3. view space -> camera's perspective
	4. clip space -> projection (ortho vs persp)
- orthographic projection is cube frustrum essentially
- perspective projection is pyramid frsutrum
- matrix multiplication goes 
	- projection -> view -> model -> local 
	- since backwards
- sent the clip space vector to vertex shader (AFTER mm)
	- mapped over viewport by openGL called viewport transform

- openGL is righthanded system (except for NDC) -> pos x is right, pos y is up and pos z is backwrds (RIGHT HAND RULE LMAO)
Todo:
- implement a texture class
- implement a transformation / rotation / scale class
- VAO.VEO.EBO class?
- think about Start() Update()
- think about creating first game