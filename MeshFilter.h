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

#include "Triangle.h"
#include "Square.h"

// contains data about Mesh's
class MeshFilter : public Component
{

public:
	//reminder: this is a pointer so the derived class can be switched at runtime
	Mesh* mesh;

	MeshFilter() : mesh(new Triangle()), Component("MeshFilter") {}
	MeshFilter(Mesh* _type) : mesh(_type), Component("MeshFilter") {}
};

#endif