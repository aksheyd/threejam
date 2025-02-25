#ifndef MESH_H
#define MESH_H

#include <iostream>
#include <glad/glad.h>
#include <GLFW/glfw3.h>
#include <glm/glm.hpp>
#include <glm/gtc/matrix_transform.hpp>
#include <glm/gtc/type_ptr.hpp>

#include <string>
#include <vector>

#include "Object.h"

class Mesh : public Object
{
protected:
	unsigned int VBO, VAO, EBO;
public:
	Mesh() :  VBO(0), VAO(0), EBO(0), Object("Mesh") {}
	Mesh(const std::string& _name) : VBO(0), VAO(0), EBO(0), Object(_name) {}

	virtual void Draw() {
		
	}

};

#endif
