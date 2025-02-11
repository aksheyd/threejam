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


Glossary

OpenGL: a formal specification of a graphics API that defines the layout and output of each function.
GLAD: an extension loading library that loads and sets all OpenGL's function pointers for us so we can use all (modern) OpenGL's functions.
Viewport: the 2D window region where we render to.
Graphics Pipeline: the entire process vertices have to walk through before ending up as one or more pixels on the screen.
Shader: a small program that runs on the graphics card. Several stages of the graphics pipeline can use user-made shaders to replace existing functionality.
Vertex: a collection of data that represent a single point.
Normalized Device Coordinates: the coordinate system your vertices end up in after perspective division is performed on clip coordinates. All vertex positions in NDC between -1.0 and 1.0 will not be discarded or clipped and end up visible.
Vertex Buffer Object: a buffer object that allocates memory on the GPU and stores all the vertex data there for the graphics card to use.
Vertex Array Object: stores buffer and vertex attribute state information.
Element Buffer Object: a buffer object that stores indices on the GPU for indexed drawing.
Uniform: a special type of GLSL variable that is global (each shader in a shader program can access this uniform variable) and only has to be set once.
Texture: a special type of image used in shaders and usually wrapped around objects, giving the illusion an object is extremely detailed.
Texture Wrapping: defines the mode that specifies how OpenGL should sample textures when texture coordinates are outside the range: (0, 1).
Texture Filtering: defines the mode that specifies how OpenGL should sample the texture when there are several texels (texture pixels) to choose from. This usually occurs when a texture is magnified.
Mipmaps: stored smaller versions of a texture where the appropriate sized version is chosen based on the distance to the viewer.
stb_image: image loading library.
Texture Units: allows for multiple textures on a single shader program by binding multiple textures, each to a different texture unit.
Vector: a mathematical entity that defines directions and/or positions in any dimension.
Matrix: a rectangular array of mathematical expressions with useful transformation properties.
GLM: a mathematics library tailored for OpenGL.
Local Space: the space an object begins in. All coordinates relative to an object's origin.
World Space: all coordinates relative to a global origin.
View Space: all coordinates as viewed from a camera's perspective.
Clip Space: all coordinates as viewed from the camera's perspective but with projection applied. This is the space the vertex coordinates should end up in, as output of the vertex shader. OpenGL does the rest (clipping/perspective division).
Screen Space: all coordinates as viewed from the screen. Coordinates range from 0 to screen width/height.
LookAt: a special type of view matrix that creates a coordinate system where all coordinates are rotated and translated in such a way that the user is looking at a given target from a given position.
Euler Angles: defined as yaw, pitch and roll that allow us to form any 3D direction vector from these 3 values.