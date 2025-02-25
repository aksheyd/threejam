#ifndef TRIANGLE_H
#define TRIANGLE_H

#include <iostream>
#include <glad/glad.h>
#include <GLFW/glfw3.h>

#include "Mesh.h"

class Triangle : public Mesh
{
public:
	Triangle() : Mesh("TriangleMesh") {
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
	}

	void Draw() {
		glBindVertexArray(VAO);
		glDrawArrays(GL_TRIANGLES, 0, 3);
	}

	~Triangle() {
		glDeleteVertexArrays(1, &VAO);
		glDeleteBuffers(1, &VBO);
	}
};

#endif