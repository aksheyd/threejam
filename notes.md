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

Camera:
- has a position, direction facing, right, and up (like transform handles in Unity)
- these are found using the diff of origin from vec3 position normalized, normalized cross product for right with direction and a up vector (just pointing straight up), and actual up axis crossing right with direction 
- lookAt function does this all for us and stores it in a matrix (view matrix becomes camera)
- 

From class (composition -> flexible alternative to inheritance):
- LECTURE 9!
- gameobject are entities that are containers of components

- vector of cpomnents with update (itearet through and call each components update)
- template class T to add new component then hit start
- for ex: make gameobject, add renderer and transform, they set them or u set them, then run update through object (which updates all components)

Todo:
- implement a texture class
- implement a transformation / rotation / scale class
- VAO.VEO.EBO class?
- think about Start() Update()
- think about creating first game
