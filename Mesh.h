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

#include "Renderer.h"

enum MeshType {
	TRIANGLE = 1,
	SQUARE = 2

};

class Mesh : public Object
{
public:
	std::vector<float> Vertices;
	unsigned int VBO, VAO;

	// Default creates a triangle?
	Mesh() : Object("Mesh") {
		float Shape[] = {
			-0.5f, -0.5f, 0.0f, // left  
			 0.5f, -0.5f, 0.0f, // right 
			 0.0f,  0.5f, 0.0f  // top   
		};

		glGenVertexArrays(1, &VAO);
		glGenBuffers(1, &VBO);
		glBindVertexArray(VAO);
		glBindBuffer(GL_ARRAY_BUFFER, VBO);
		glBufferData(GL_ARRAY_BUFFER, sizeof(Shape), Shape, GL_STATIC_DRAW);
		
		// position attribute
		glVertexAttribPointer(0, 3, GL_FLOAT, GL_FALSE, 3 * sizeof(float), (void*)0);
		glEnableVertexAttribArray(0);

		glBindBuffer(GL_ARRAY_BUFFER, 0);
		glBindVertexArray(0);

		Vertices = std::vector<float>(Shape, Shape + 9);
	}

	void BindVertexArray() {
		glBindVertexArray(VAO);
	}

	~Mesh() {
		glDeleteVertexArrays(1, &VAO);
		glDeleteBuffers(1, &VBO);
	}
};

#endif