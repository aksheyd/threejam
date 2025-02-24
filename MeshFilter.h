#ifndef MESHFILTER_H
#define MESHFILTER_H

#include <iostream>
#include <glad/glad.h>
#include <GLFW/glfw3.h>
#include <glm/glm.hpp>
#include <glm/gtc/matrix_transform.hpp>
#include <glm/gtc/type_ptr.hpp>

#include <string>
#include <vector>

#include "Renderer.h"
#include "Mesh.h"

// contains data about Mesh's
class MeshFilter : public Component
{

public:
	Mesh mesh;

	MeshFilter() : mesh(), Component("MeshFilter") { }
};

#endif